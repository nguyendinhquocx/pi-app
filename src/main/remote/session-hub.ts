import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { posix as posixPath, win32 as win32Path } from 'node:path'
import { normalizeSessionFileKey } from '@shared/session-file-key'
import type { BranchInfo, Cursor, DiffFile, DiffLine, OpenResult, RemoteEvent, SessionSummary, Turn, TurnPatch, UiRequest } from '@shared/remote'
import { base64UrlEncode } from '@shared/remote'
import { currentVisibleSessionFile, externalCompletionAlertsEnabled, observeAppEventForCompletion } from '../completion-notification-events'
import type { AppEvent } from '@shared/app-events'
import { RpcFail } from './errors'
import type { HostSessionHistory, HostSessionRow, HostTimelineItem, RemoteHostPort } from './host-port'
import { LiveProjector, projectHistory, type PatchBody } from './projector'
import { branchesFromTree } from './branches'
import { capLines, parsePiDiff, parseUnifiedDiff, type ParsedDiffFile } from './diff-model'
import { outputText } from './render-node'
import { registerExternalChangeTarget, externalWatchTrace, type ExternalChangeResult, type SessionFileChangeSignal } from './session-file-watcher'
import type { UiRouter } from './ui-router'

/** A connected, authenticated remote client as the hub sees it. */
export interface HubClient {
  readonly id: string
  sendEvent(event: RemoteEvent, payload: unknown): void
  queuePatches(sessionKey: string, patches: TurnPatch[]): void
}

export const RING_MAX = 2000
export const PAGE_SIZE = 20
const LIST_PUSH_MS = 300
/** A slot event this recent makes the watcher skip the entry (slot owns the data right now). */
const SLOT_QUIET_MS = 60_000
/** Rows refresh for the watcher's observation set (header scan only, no previews). */
const ROWS_REFRESH_MS = 30_000
/** Non-terminal tail + no file activity for this long ⇒ the external run is dead: go idle. */
const EXTERNAL_RUNNING_BACKSTOP_MS = 90_000
/** Completion metadata is a 2-minute reconnect proof, then it ages out. */
const SETTLED_OUTCOME_FRESH_MS = 120_000
/** iss_20261121165413: how long a session.create announce row survives without a disk-visible transcript. */
const ANNOUNCE_PENDING_MS = 10 * 60_000

/** Convert a canonical wire key to a filesystem path without changing path flavor. */
function normalizeHostSessionPath(sessionFile: string): string {
  if (process.platform === 'win32' && (/^[a-zA-Z]:[\\/]/.test(sessionFile) || sessionFile.startsWith('\\\\') || sessionFile.startsWith('//'))) {
    return win32Path.normalize(sessionFile)
  }
  return posixPath.normalize(sessionFile)
}

/**
 * Wire session-key guard (spec T2): a client-supplied session key is only ever resolved to a
 * transcript in a session store — `.jsonl` suffix, no null bytes, no `..` traversal anywhere.
 * Keys that come from warm host rows (allowedProjects rows) are canonical host data and skip
 * this check (they were already validated when the row was created from the disk scan).
 */
export function wireSessionKeyIsResolvable(sessionKey: string): boolean {
  if (!sessionKey || sessionKey.includes('\u0000')) return false
  // Split on both separators: `..` traversal must be rejected in either flavor.
  for (const seg of sessionKey.split(/[\\/]/)) {
    if (seg === '..' || seg === '.') return false
  }
  return sessionKey.toLowerCase().endsWith('.jsonl')
}
const ENRICH_TOP = 10
const OUTPUT_KEEP = 50
const OUTPUT_MAX = 256 * 1024

type Entry = {
  key: string
  sessionFile: string
  projector: LiveProjector
  seq: number
  ring: TurnPatch[]
  subscribers: Set<HubClient>
  seeded: boolean
  lastAnswer?: string
  lastFailure?: string
  updatedAt: number
  outputs: Map<string, string>
  /** Only `onAppEvent` writes this; `updatedAt` is owned by publishers and would poison the guard. */
  lastSlotEventAt?: number
  /** True only when the latest running value came from the file watcher, not a slot AppEvent. */
  externalRunning?: boolean
  /** Baseline of what this entry already PUBLISHED to clients (own field — the history cache is overwritten by enrich()/open()). */
  lastPublishedTurns?: Turn[]
  /** Raw history items from the last external read — running derivation needs them (projected turns always settle). */
  rawItems?: HostTimelineItem[]
  /** Tail-terminal state of the previous reconcile tick: the completion transition detector. */
  lastObservedTailTerminal?: boolean
  /** Running turn anchor last observed; prevents branch switches from looking like completions. */
  lastObservedTailTurnAnchor?: string
  /** Anchor of the turn whose completion was already synthesized (one notification per turn). */
  lastNotifiedTurnAnchor?: string
  /** Terminal outcome of the last settle (worker slot settle, or external terminal tail) + when.
   *  summaryFor exposes it as `settledOutcome` while fresh so remote clients can tell a real
   *  completion from the 90s backstop flip (long tool call, status idle but still running). */
  lastSettledOutcome?: 'success' | 'failed' | 'cancelled'
  lastSettledOutcomeAt?: number
}

type HistoryCache = { stamp: string; turns: Turn[] }

const firstLine = (text: string, max = 120): string => {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[#>*\-\s`]+/, '').trim()
    if (line && !line.startsWith('```')) return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  return ''
}

export function uiPreview(req: UiRequest): string {
  switch (req.method) {
    case 'custom':
      return req.kind === 'ask_user_question' ? (req.questions[0]?.question ?? '') : req.question
    case 'notify':
      return req.message
    default:
      return req.title
  }
}

export class SessionHub {
  readonly epoch = `e_${base64UrlEncode(randomBytes(6))}`
  private readonly entries = new Map<string, Entry>()
  private readonly history = new Map<string, HistoryCache>()
  private readonly rows = new Map<string, HostSessionRow>()
  private readonly enriched = new Map<string, { stamp: number; preview?: string; turn?: Turn }>()
  private readonly listWatchers = new Map<HubClient, { projectId?: string }>()
  private readonly dirty = new Set<string>()
  private readonly removedDirty = new Map<string, string>()
  private listTimer: ReturnType<typeof setTimeout> | null = null
  private readonly refreshing = new Set<string>()
  /** Sessions created from a phone that the desktop sidebar has not been told about yet (key → project). */
  private readonly unlisted = new Map<string, string>()
  private readonly probing = new Set<string>()
  private unregisterExternalTarget: (() => void) | null = null
  private rowsRefreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly port: RemoteHostPort,
    private readonly ui: UiRouter,
    private readonly allowedProjects: () => string[],
    private readonly now: () => number = Date.now,
  ) {
    this.unregisterExternalTarget = registerExternalChangeTarget({
      observedSessionFiles: () => {
        // Observe EVERY session of the allowed projects (rows), not just phone-opened entries:
        // a TUI session nobody opened yet must still live-update. The watcher dedupes by key.
        const files = [...this.entries.values()].map((e) => e.sessionFile)
        for (const r of this.rows.values()) if (r.sessionFile) files.push(r.sessionFile)
        const visible = currentVisibleSessionFile()
        if (visible) files.push(visible)
        return files
      },
      onExternalChange: (file) => this.onExternalChange(file),
      onWatchTick: (stamps) => this.onWatchTick(stamps),
    })
    // Keep rows fresh even with no phone connected so the observation set covers newly created
    // TUI sessions; header scan only (no preview enrichment), cheap at 30s.
    this.rowsRefreshTimer = setInterval(() => void this.refreshRowsQuiet(), ROWS_REFRESH_MS)
    this.rowsRefreshTimer.unref?.()
  }

  /** Header-scan refresh of all allowed projects' rows; keeps previous rows on failure. */
  private async refreshRowsQuiet(): Promise<void> {
    const allowed = this.allowedProjects()
    const allowedKeys = new Set(allowed.map((p) => normalizeSessionFileKey(p).replace(/\/+$/, '')))
    for (const p of allowed) {
      if (this.refreshing.has(p)) continue
      this.refreshing.add(p)
      try {
        await this.loadRows(p)
      } catch {
        /* keep previous rows */
      } finally {
        this.refreshing.delete(p)
      }
    }
    // Drop rows of projects no longer in the allowlist: the watch scope must follow it.
    for (const [k, r] of this.rows) {
      const pk = normalizeSessionFileKey(r.projectId).replace(/\/+$/, '')
      if (!allowedKeys.has(pk)) {
        this.rows.delete(k)
        this.dirty.delete(k)
        if (this.listWatchers.size) {
          this.removedDirty.set(k, r.projectId)
          this.scheduleListFlush()
        }
      }
    }
  }

  /** A transport stopped (e.g. Remote Gateway disabled): drop clients, keep app-level file watching. */
  suspend(): void {
    if (this.listTimer) clearTimeout(this.listTimer)
    this.listTimer = null
    this.listWatchers.clear()
    for (const e of this.entries.values()) e.subscribers.clear()
  }

  /**
   * Drop gateway clients. The SessionHub instance is cached across gateway enable/disable, so its
   * app-level watcher target must remain registered even when the transport is stopped.
   */
  /** Test seam: is the app-level rows refresh loop armed (gateway stop/start must not kill it)? */
  rowsRefreshArmed(): boolean {
    return this.rowsRefreshTimer !== null
  }

  dispose(): void {
    this.suspend()
    if (this.rowsRefreshTimer) {
      clearInterval(this.rowsRefreshTimer)
      this.rowsRefreshTimer = null
    }
  }

  /** Final target cleanup for tests or an owner that truly discards this hub instance. */
  disposeExternalWatch(): void {
    this.unregisterExternalTarget?.()
    this.unregisterExternalTarget = null
    if (this.rowsRefreshTimer) {
      clearInterval(this.rowsRefreshTimer)
      this.rowsRefreshTimer = null
    }
  }

  // ── Projects / authorization ──

  isAllowedProject(projectId: string): boolean {
    const want = normalizeSessionFileKey(projectId).replace(/\/+$/, '')
    return this.allowedProjects().some((p) => normalizeSessionFileKey(p).replace(/\/+$/, '') === want)
  }

  private allowedProjectFor(projectId: string): string | undefined {
    const want = normalizeSessionFileKey(projectId).replace(/\/+$/, '')
    return this.allowedProjects().find((p) => normalizeSessionFileKey(p).replace(/\/+$/, '') === want)
  }

  /** Resolve the session's workspace and require it to be whitelisted. */
  async authorize(sessionKey: string): Promise<{ entry: Entry; projectId: string }> {
    const canonicalKey = normalizeSessionFileKey(sessionKey)
    const row = this.rows.get(canonicalKey)
    // A canonical wire key can resolve without a warm session-list row. Convert it to the
    // host-native path form before filesystem/SDK calls; never persist wire spelling as I/O path.
    // Unknown keys must still look like a real transcript path: `.jsonl`, no traversal.
    const sessionFile = row?.sessionFile ?? (wireSessionKeyIsResolvable(sessionKey) ? normalizeHostSessionPath(sessionKey) : null)
    if (!sessionFile) throw new RpcFail('not_found', 'unknown session')
    const cwd = row?.projectId ?? (await this.port.sessionProject(sessionFile))
    const projectId = cwd ? this.allowedProjectFor(cwd) : undefined
    if (!projectId) throw new RpcFail('forbidden', 'session is not in an allowed project')
    return { entry: this.entryFor(sessionFile), projectId }
  }

  private entryFor(sessionFile: string): Entry {
    const key = normalizeSessionFileKey(sessionFile)
    const rawSessionFile = this.rows.get(key)?.sessionFile ?? normalizeHostSessionPath(sessionFile)
    let e = this.entries.get(key)
    if (!e) {
      e = {
        key,
        sessionFile: rawSessionFile,
        projector: new LiveProjector((tool) => this.toolCard(tool, key), this.now),
        seq: 0,
        ring: [],
        subscribers: new Set(),
        seeded: false,
        updatedAt: 0,
        outputs: new Map(),
      }
      this.entries.set(key, e)
    } else if (this.rows.has(key)) {
      // Enrichment may have created the entry from the canonical wire key before an RPC arrived.
      // Once the host row is known, restore the exact path spelling used by local host I/O.
      e.sessionFile = rawSessionFile
    }
    return e
  }

  private toolCard(toolName: string, key: string) {
    const project = this.rows.get(key)?.projectId
    return project ? this.port.toolCardFor(toolName, project) : undefined
  }

  // ── Live events ──

  onAppEvent(event: AppEvent): void {
    const file = 'sessionFile' in event ? event.sessionFile : undefined
    if (!file) return
    const entry = this.entryFor(file)
    entry.lastSlotEventAt = this.now()
    entry.externalRunning = false
    if (event.type === 'tool' && event.phase === 'end') this.keepOutput(entry, event.toolCallId, outputText(event.output))
    const bodies = entry.projector.apply(event)
    if (!bodies.length) return
    entry.updatedAt = this.now()
    for (const b of bodies) {
      if (b.op === 'turn.upsert' && b.turn.status === 'running') {
        entry.lastFailure = undefined
        // A fresh turn invalidates the previous turn's completion proof. Otherwise a later
        // 90s backstop idle flip after a crash could reuse the old success outcome.
        entry.lastSettledOutcome = undefined
        entry.lastSettledOutcomeAt = undefined
      }
      if (b.op === 'turn.settle') {
        const live = entry.projector.liveTurn
        if (b.status === 'done' && live) entry.lastAnswer = firstLine(live.answer) || entry.lastAnswer
        entry.lastFailure = b.status === 'failed' ? b.error?.text || 'failed' : undefined
        entry.lastSettledOutcome = b.status === 'done' ? 'success' : b.status === 'failed' ? 'failed' : 'cancelled'
        entry.lastSettledOutcomeAt = this.now()
      }
    }
    this.publish(entry, bodies)
    if (this.unlisted.has(entry.key)) void this.announceToDesktop(entry, bodies.some((b) => b.op === 'turn.settle'))
    if (!this.rows.has(entry.key)) void this.refreshRowsFor(entry.sessionFile)
    this.markDirty(entry.key)
  }

  /**
   * pi writes a new session file only once the first reply lands, so the desktop list cannot show
   * a phone-created session until then. Tell the renderer as soon as the file exists (or the run settles).
   */
  private async announceToDesktop(entry: Entry, settled: boolean): Promise<void> {
    if (!settled) {
      if (this.probing.has(entry.key)) return
      this.probing.add(entry.key)
      const exists = await stat(entry.sessionFile).then(() => true, () => false)
      this.probing.delete(entry.key)
      if (!exists) return
    }
    const projectId = this.unlisted.get(entry.key)
    if (!projectId) return
    this.unlisted.delete(entry.key)
    this.port.notifySessionsChanged(projectId)
  }

  private keepOutput(entry: Entry, toolCallId: string, text: string): void {
    if (!toolCallId || !text) return
    entry.outputs.delete(toolCallId)
    entry.outputs.set(toolCallId, text.length > OUTPUT_MAX ? text.slice(text.length - OUTPUT_MAX) : text)
    while (entry.outputs.size > OUTPUT_KEEP) entry.outputs.delete(entry.outputs.keys().next().value as string)
  }

  private publish(entry: Entry, bodies: PatchBody[]): void {
    const patches = bodies.map((b) => ({ ...b, seq: ++entry.seq }) as TurnPatch)
    entry.ring.push(...patches)
    if (entry.ring.length > RING_MAX) entry.ring.splice(0, entry.ring.length - RING_MAX)
    for (const c of entry.subscribers) c.queuePatches(entry.key, patches)
    this.applyToBaseline(entry, bodies)
  }

  /**
   * The baseline mirrors what clients have already seen. Only the publish path touches it —
   * `enrich()`/`open()` overwrite the history cache at any time, this field must not.
   */
  private applyToBaseline(entry: Entry, bodies: PatchBody[]): void {
    let turns = entry.lastPublishedTurns
    for (const b of bodies) {
      if (b.op === 'timeline.reset') {
        turns = undefined
        continue
      }
      if (b.op === 'turn.upsert') {
        const base = turns ? turns.slice() : []
        // Match by id first (stable across the slot's setAnchor), then by anchor.
        let i = base.findIndex((t) => t.id === b.turn.id)
        if (i < 0) i = base.findIndex((t) => t.anchor === b.turn.anchor)
        if (i >= 0) base[i] = structuredClone(b.turn)
        else base.push(structuredClone(b.turn))
        turns = base
        continue
      }
      if (!turns) continue
      if (b.op === 'text.append') {
        const i = turns.findIndex((t) => t.id === b.turnId)
        if (i < 0) continue
        const next = turns.slice()
        const prev = next[i]
        if (b.ref === 'answer') next[i] = { ...prev, answer: prev.answer + b.delta }
        else next[i] = { ...prev, steps: prev.steps.map((s) => s.id === b.ref && s.kind === 'thinking' ? { ...s, text: s.text + b.delta } : s) }
        turns = next
        continue
      }
      if (b.op === 'turn.promote') {
        const i = turns.findIndex((t) => t.id === b.turnId)
        if (i < 0) continue
        const next = turns.slice()
        next[i] = { ...next[i], answer: '', steps: [...next[i].steps, structuredClone(b.step)] }
        turns = next
        continue
      }
      if (b.op === 'step.upsert') {
        const i = turns.findIndex((t) => t.id === b.turnId)
        if (i < 0) continue
        const prev = turns[i]
        const stepIndex = prev.steps.findIndex((s) => s.id === b.step.id)
        const steps = prev.steps.slice()
        if (stepIndex >= 0) steps[stepIndex] = structuredClone(b.step)
        else steps.push(structuredClone(b.step))
        const { live: _oldLive, ...activity } = prev.activity
        turns = turns.slice()
        turns[i] = {
          ...prev,
          steps,
          activity: { ...activity, counts: b.counts, failed: b.failed, ...(b.live ? { live: b.live } : {}) },
        }
        continue
      }
      if (b.op === 'turn.settle') {
        const i = turns.findIndex((t) => t.id === b.turnId)
        if (i < 0) continue
        const prev = turns[i]
        const next = turns.slice()
        next[i] = {
          ...prev,
          status: b.status,
          ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}),
          files: b.files,
          ...(b.error ? { error: b.error } : {}),
        }
        turns = next
      }
    }
    if (turns) entry.lastPublishedTurns = turns
    else entry.lastPublishedTurns = undefined
  }

  /** Extension UI state changed for a session: inbox status may flip to/from "needs input". */
  onUiChanged(sessionKey: string): void {
    this.markDirty(normalizeSessionFileKey(sessionKey))
  }

  // ── External file reconcile (SessionFileWatcher) ──

  /**
   * Slot arbitration uses slot-only timestamps. The watcher can also set projector.running, so
   * `externalRunning` keeps that state from self-suppressing its next file tick. A recent slot event
   * always wins for 60s; after silence the external file takes ownership (also recovering a crashed slot).
   */
  private async skipForSlotActivity(entry: Entry): Promise<boolean> {
    const lastSlot = entry.lastSlotEventAt
    const recentSlotEvent = lastSlot !== undefined && this.now() - lastSlot < SLOT_QUIET_MS
    if (recentSlotEvent) {
      externalWatchTrace('slot:' + entry.key, `defer: slot event ${Math.round((this.now() - (lastSlot ?? 0)) / 1000)}s ago (< ${SLOT_QUIET_MS / 1000}s)`)
      return true
    }
    // The watcher must not suppress its own external-running state. Slot state is different:
    // after the event-quiet window, verify the worker pool directly before clearing its live turn.
    if (entry.externalRunning) return false
    const projectorLooksRunning = entry.projector.sessionState.running || entry.projector.liveTurn?.status === 'running'
    if (!projectorLooksRunning) return false
    const slot = await this.port.liveState(entry.sessionFile).catch(() => null)
    // Probe failure is inconclusive: defer rather than clobber a possibly-live slot. A later tick
    // retries; a missing worker returns running=false and lets disk recover a crashed slot.
    if (slot === null || slot.running) {
      externalWatchTrace('slot:' + entry.key, `defer: liveState probe ${slot === null ? 'threw' : 'says running'}`)
      return true
    }
    return false
  }

  /**
   * A watched session file changed on disk: re-read it, diff against what clients already
   * received, and publish upserts / a settle / a structural reset. Returns the renderer
   * signal (or null when the entry was skipped / unreadable).
   */
  async onExternalChange(sessionFile: string): Promise<ExternalChangeResult> {
    const entry = this.entryFor(sessionFile)
    if (await this.skipForSlotActivity(entry)) return { status: 'deferred' }
    // Past the window: the file is the truth now — a stale live turn (slot crashed mid-run) would
    // otherwise overlay it and hide the settled tail from the diff.
    entry.projector.clearLiveTurn()
    const projectId = this.rows.get(entry.key)?.projectId ?? (await this.port.sessionProject(entry.sessionFile).catch(() => null))
    if (!projectId) {
      externalWatchTrace('hub:' + entry.key, 'retry: no projectId (row missing, sessionProject failed)')
      return { status: 'retry' }
    }
    const stamp = await this.historyStamp(entry.sessionFile)
    let h: HostSessionHistory
    try {
      h = await this.port.readHistory(projectId, entry.sessionFile)
    } catch {
      // Torn tail / unreadable file: skip the cycle, keep the baseline, retry on a later tick.
      externalWatchTrace('hub:' + entry.key, 'retry: readHistory threw (torn tail?)')
      return { status: 'retry' }
    }
    // A slot event may have landed during the read (~100-300ms): deriving running from the
    // (now stale) disk tail would clobber a live slot — defer; the slot events carry updates.
    if (entry.lastSlotEventAt !== undefined && this.now() - entry.lastSlotEventAt < SLOT_QUIET_MS) {
      externalWatchTrace('hub:' + entry.key, 'defer: slot event landed during read')
      return { status: 'deferred' }
    }
    // One read serves both consumers: raw items for running derivation, projected turns for diff.
    entry.rawItems = h.items
    const cached = this.history.get(entry.key)
    const turns = cached && cached.stamp === stamp ? cached.turns : projectHistory(h.items, (tool) => this.port.toolCardFor(tool, projectId), { model: h.model, thinking: h.thinking })
    if (!cached || cached.stamp !== stamp) this.setHistoryCache(entry.key, stamp, turns)

    const current = this.mergedTurns(entry, turns)
    const baseline = entry.lastPublishedTurns
    const tailOutcome = externalTerminalOutcome(h.items.at(-1))
    const currentTailAnchor = current.at(-1)?.anchor
    const previousTailAnchor = entry.lastObservedTailTurnAnchor ?? baseline?.at(-1)?.anchor
    const previousTailTerminal = entry.lastObservedTailTerminal
    const externalTailAnchorChanged = !!currentTailAnchor && currentTailAnchor !== previousTailAnchor
    if (externalTailAnchorChanged) {
      // External TUI turn started. Retire the previous turn's result now; if this new turn later
      // hits the 90s file-silence backstop, Android must not reuse the old success/failure.
      entry.lastSettledOutcome = undefined
      entry.lastSettledOutcomeAt = undefined
      entry.lastFailure = undefined
    }
    // Structural change: the history shrank or a published anchor vanished — only a reset
    // represents it. An absent baseline (fresh epoch) is NOT structural: upsert everything once.
    const structuralChange = Boolean(
      baseline && (current.length < baseline.length || baseline.some((t) => !current.some((c) => c.anchor === t.anchor))),
    )
    if (structuralChange) {
      this.publish(entry, [{ op: 'timeline.reset' }])
      entry.lastPublishedTurns = structuredClone(current)
      externalWatchTrace('hub:' + entry.key, `processed: reset (turns=${current.length}, baseline=${baseline?.length ?? 'none'})`)
    } else {
      const bodies: PatchBody[] = []
      for (const turn of current) {
        const prev = baseline?.find((t) => t.anchor === turn.anchor)
        if (!prev) {
          bodies.push({ op: 'turn.upsert', turn })
        } else if (prev.status === 'running' && turn.status !== 'running') {
          // The disk carries the final answer/steps, which a settle patch cannot transport.
          // Upsert the authoritative body when it changed, then settle the same (now stable) id.
          const changed = externalTurnChanged(prev, turn)
          if (changed) bodies.push({ op: 'turn.upsert', turn })
          bodies.push({
            op: 'turn.settle',
            turnId: changed ? turn.id : prev.id,
            status: turn.status,
            ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
            files: turn.files,
            ...(turn.error ? { error: turn.error } : {}),
          })
        } else if (externalTurnChanged(prev, turn)) {
          bodies.push({ op: 'turn.upsert', turn })
        }
      }
      if (bodies.length) this.publish(entry, bodies)
      if (bodies.length || baseline === undefined) {
        externalWatchTrace('hub:' + entry.key, `processed: bodies=${bodies.length} (turns=${current.length}, baseline=${baseline?.length ?? 'none'})`)
      }
    }
    entry.updatedAt = stampEpochMs(stamp) || this.now()
    const running = this.deriveExternalRunning(entry, stamp)
    this.applyExternalRunningState(entry, running)
    this.observeExternalCompletion(entry, projectId, current, baseline, structuralChange)

    const outcomeAt = stampEpochMs(stamp) ?? this.now()
    const outcomeAge = this.now() - outcomeAt
    const freshFirstSeenTerminal = previousTailTerminal === undefined && tailOutcome !== null &&
      outcomeAge >= 0 && outcomeAge <= SETTLED_OUTCOME_FRESH_MS
    const newlyObservedTerminal = tailOutcome !== null && !structuralChange &&
      (previousTailTerminal === false || externalTailAnchorChanged || freshFirstSeenTerminal)
    if (tailOutcome === 'failed') {
      entry.lastFailure = clampPreview(h.items.at(-1)?.text) || current.at(-1)?.error?.text || 'failed'
    } else if (tailOutcome === 'success' || tailOutcome === 'cancelled') {
      entry.lastFailure = undefined
    }
    if (newlyObservedTerminal && (entry.lastSettledOutcomeAt === undefined || outcomeAt >= entry.lastSettledOutcomeAt)) {
      entry.lastSettledOutcome = tailOutcome
      entry.lastSettledOutcomeAt = outcomeAt
    }
    this.markDirty(entry.key)
    return { status: 'processed', signal: { sessionFile: entry.sessionFile, running } }
  }

  /**
   * Synthesize a completion event for the notification sink, ONLY on an observed transition
   * between two reconcile ticks (previous tail non-terminal → this tail terminal with a real
   * stopReason). The first observation of an old session only seeds the baseline — no notify;
   * heuristic running flips never notify (they carry no stopReason).
   */
  private observeExternalCompletion(entry: Entry, projectId: string, current: Turn[], baseline: Turn[] | undefined, structuralChange: boolean): void {
    const items = entry.rawItems ?? []
    const tail = items[items.length - 1]
    const terminalOutcome = externalTerminalOutcome(tail)
    const previous = entry.lastObservedTailTerminal
    const previousTurnAnchor = entry.lastObservedTailTurnAnchor ?? baseline?.at(-1)?.anchor
    const turn = current[current.length - 1]
    const baselineTailAnchor = baseline?.at(-1)?.anchor
    const baselineIsPrefix = baseline !== undefined && baseline.every((old, i) => current[i]?.anchor === old.anchor)
    const newlyAppendedTerminalTurn = baselineIsPrefix && !structuralChange && !!turn && terminalOutcome !== null &&
      current.length > (baseline?.length ?? 0) && turn.anchor !== baselineTailAnchor
    const sameTurnJustSettled = !structuralChange && previous === false && !!turn && previousTurnAnchor === turn.anchor && terminalOutcome !== null
    entry.lastObservedTailTerminal = terminalOutcome !== null
    entry.lastObservedTailTurnAnchor = turn?.anchor
    if (!externalCompletionAlertsEnabled()) return
    if (terminalOutcome === null || (!newlyAppendedTerminalTurn && !sameTurnJustSettled)) return
    // A changed tail can be a fast-completed new turn (no intermediate poll observed it as live).
    // Structural rewinds/branch switches are excluded above; first observation has no baseline.
    if (!turn || turn.status === 'running') return
    if (entry.lastNotifiedTurnAnchor === turn.anchor) return
    entry.lastNotifiedTurnAnchor = turn.anchor
    observeAppEventForCompletion({
      type: 'completion',
      // CompletionOutcome vocabulary is success/failed/cancelled (spec's "done" maps to success).
      outcome: terminalOutcome,
      settled: true,
      sessionFile: entry.sessionFile,
      workspaceId: this.rows.get(entry.key)?.projectId ?? projectId,
      runId: turn.anchor,
      promptPreview: clampPreview(turn.user?.text),
      responsePreview: clampPreview(turn.answer),
      seq: 0,
      timestamp: this.now(),
      source: 'external-watcher',
    })
  }

  /** Every watcher tick: re-evaluate running on entries running right now (slot entries without
   *  raw items are untouched; a slot crashed >60s ago gets recovered from disk). */
  async onWatchTick(stamps: ReadonlyMap<string, string>): Promise<SessionFileChangeSignal[]> {
    const signals: SessionFileChangeSignal[] = []
    for (const entry of this.entries.values()) {
      // externalRunning entries re-derive too: an `open()` seed (slot probe) may have just
      // clobbered state.running to false — this tick heals it from the file within one interval.
      if (!entry.projector.sessionState.running && !entry.externalRunning) continue
      if (await this.skipForSlotActivity(entry)) continue
      if (!entry.rawItems?.length) continue // never externally read: the running flag belongs to a slot
      const stamp = stamps.get(entry.key) ?? (await this.historyStamp(entry.sessionFile))
      const running = this.deriveExternalRunning(entry, stamp)
      if (running === entry.projector.sessionState.running) continue
      this.applyExternalRunningState(entry, running)
      this.markDirty(entry.key)
      signals.push({ sessionFile: entry.sessionFile, running })
    }
    return signals
  }

  /** Publish the full state (mobile `session.state` is replace-all — partial would drop fields). */
  private applyExternalRunningState(entry: Entry, running: boolean): void {
    entry.externalRunning = running
    if (entry.projector.sessionState.running === running) return
    this.publish(entry, [entry.projector.setExternalState({ ...entry.projector.sessionState, running })])
  }

  /**
   * Heuristic, derived from RAW items (projected turns always settle, so they cannot tell
   * "running"). Terminal tail ⇒ idle. Non-terminal tail ⇒ running until the file goes quiet
   * for >90s (process crashed mid-turn) — re-evaluated on every tick, never sticky.
   */
  private deriveExternalRunning(entry: Entry, stamp: string): boolean {
    const items = entry.rawItems ?? []
    const tail = items[items.length - 1]
    if (!tail) return false
    const terminal = externalTerminalOutcome(tail) !== null
    if (terminal) return false
    const mtimeMs = stampEpochMs(stamp)
    if (mtimeMs === undefined) return false
    return this.now() - mtimeMs <= EXTERNAL_RUNNING_BACKSTOP_MS
  }

  subscribersOf(sessionKey: string): HubClient[] {
    return [...(this.entries.get(normalizeSessionFileKey(sessionKey))?.subscribers ?? [])]
  }

  // ── Session list / inbox ──

  private async refreshRowsFor(sessionFile: string): Promise<void> {
    const project = await this.port.sessionProject(sessionFile).catch(() => null)
    if (!project) return
    const allowed = this.allowedProjectFor(project)
    if (!allowed || this.refreshing.has(allowed)) return
    this.refreshing.add(allowed)
    try {
      await this.loadRows(allowed)
      this.markDirty(normalizeSessionFileKey(sessionFile))
    } finally {
      this.refreshing.delete(allowed)
    }
  }

  private async loadRows(projectId: string): Promise<HostSessionRow[]> {
    const rows = await this.port.listSessions(projectId)
    const fresh = new Set<string>()
    for (const r of rows) {
      const key = normalizeSessionFileKey(r.sessionFile)
      fresh.add(key)
      const previous = this.rows.get(key)
      this.rows.set(key, { ...r, projectId })
      // A row can change without its JSONL content changing (rename, reindex, new session).
      const changed = !previous || previous.title !== r.title || previous.updatedAt !== r.updatedAt || previous.firstMessage !== r.firstMessage
      if (changed) {
        this.removedDirty.delete(key)
        this.markDirty(key)
      }
    }
    // Prune this project's rows whose file vanished and tell list subscribers; otherwise their
    // cached inbox keeps deleted sessions forever even though the watcher stopped stat-ing them.
    // A just-created session's transcript only appears with the first reply (iss_20261121165413):
    // its provisional announce row would fail this freshness scan and the very next session.open
    // would resolve no row and no sessionProject → forbidden. Keep announced rows until their
    // short provisional lease expires, then treat them like any other vanished file.
    for (const [k, r] of this.rows) {
      const pendingAnnounce = typeof r.provisionalUntil === 'number' && r.provisionalUntil > this.now()
      if (r.projectId === projectId && !fresh.has(k) && !pendingAnnounce) {
        this.rows.delete(k)
        this.dirty.delete(k)
        if (this.listWatchers.size) {
          this.removedDirty.set(k, projectId)
          this.scheduleListFlush()
        }
      }
    }
    return rows.map((r) => ({ ...r, projectId }))
  }

  private summaryFor(row: HostSessionRow, pending: Map<string, UiRequest>): SessionSummary {
    const key = normalizeSessionFileKey(row.sessionFile)
    const e = this.entries.get(key)
    const state = e?.projector.sessionState
    const live = e?.projector.liveTurn
    const ask = pending.get(key)
    const extra = this.enriched.get(key)
    const running = !!state?.running
    const settledFresh = e?.lastSettledOutcome && e.lastSettledOutcomeAt !== undefined &&
      this.now() - e.lastSettledOutcomeAt <= SETTLED_OUTCOME_FRESH_MS
    const settledAt = !running && !ask && settledFresh ? e.lastSettledOutcomeAt : undefined
    const settledOutcome = settledAt !== undefined ? e?.lastSettledOutcome : undefined
    const status: SessionSummary['status'] = ask ? 'needsInput' : running ? 'running' :
      e?.lastFailure || settledOutcome === 'failed' ? 'failed' : 'idle'
    const out: SessionSummary = {
      // Session identity crosses the wire; keep it canonical even though host I/O uses the raw path.
      sessionKey: key,
      projectId: row.projectId,
      title: row.title,
      status,
      updatedAt: Math.floor(Math.max(row.updatedAt, e?.updatedAt ?? 0)),
    }
    const preview = ask ? uiPreview(ask) : status === 'failed' ? e?.lastFailure : e?.lastAnswer ?? extra?.preview ?? (row.firstMessage ? firstLine(row.firstMessage) : undefined)
    if (preview) out.preview = preview
    if (settledOutcome && settledAt !== undefined) {
      out.settledOutcome = settledOutcome
      out.settledAt = Math.floor(settledAt)
    }
    const turn = running && live ? live : (live ?? extra?.turn)
    if (turn) {
      out.counts = turn.activity.counts
      if (turn.files.length) out.filesChanged = turn.files.length
      if (running && live) {
        if (live.startedAt) out.startedAt = live.startedAt
        const step = live.steps.find((s) => s.id === live.activity.live) ?? live.steps[live.steps.length - 1]
        if (step?.kind === 'tool') {
          out.live = step.node.title
          out.liveCategory = step.category
        } else if (step?.kind === 'thinking') out.live = ''
      }
    }
    return out
  }

  async listSummaries(projectId?: string): Promise<SessionSummary[]> {
    const projects = projectId ? (this.allowedProjectFor(projectId) ? [this.allowedProjectFor(projectId)!] : []) : this.allowedProjects()
    if (projectId && !projects.length) throw new RpcFail('forbidden', 'project is not allowed')
    const listed = (await Promise.all(projects.map((p) => this.loadRows(p).catch(() => [] as HostSessionRow[])))).flat()
    // iss_20261121165413: a just-created session exists only as a provisional announce row until
    // its transcript file appears with the first reply — merge pending rows the disk listing
    // does not include yet so the phone rail shows the session it just created.
    const listedKeys = new Set(listed.map((r) => normalizeSessionFileKey(r.sessionFile)))
    const now = this.now()
    const announced = [...this.rows.values()].filter(
      (r) => typeof r.provisionalUntil === 'number' && r.provisionalUntil > now && !listedKeys.has(normalizeSessionFileKey(r.sessionFile)),
    )
    const rows = [...listed, ...announced]
    const pending = this.ui.pendingBySession()
    return rows.map((r) => this.summaryFor(r, pending)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async watchList(client: HubClient, projectId?: string): Promise<SessionSummary[]> {
    const sessions = await this.listSummaries(projectId)
    this.listWatchers.set(client, { ...(projectId ? { projectId } : {}) })
    void this.enrich(sessions)
    return sessions
  }

  unwatchList(client: HubClient): void {
    this.listWatchers.delete(client)
  }

  /** Fill previews of the most recent idle sessions from their history (cached by file stamp). */
  private async enrich(sessions: SessionSummary[]): Promise<void> {
    const candidates = sessions.filter((s) => s.status === 'idle').slice(0, ENRICH_TOP)
    for (const s of candidates) {
      const key = normalizeSessionFileKey(s.sessionKey)
      if (this.entries.get(key)?.lastAnswer) continue
      if ((this.enriched.get(key)?.stamp ?? -1) >= s.updatedAt) continue
      try {
        const turns = await this.loadHistoryTurns(this.entryFor(s.sessionKey), s.projectId)
        const last = turns[turns.length - 1]
        this.enriched.set(key, { stamp: s.updatedAt, ...(last ? { turn: last, preview: firstLine(last.answer) || undefined } : {}) })
        this.markDirty(key)
      } catch {
        /* preview stays the first message */
      }
    }
  }

  private markDirty(key: string): void {
    if (!this.listWatchers.size) return // future watchList receives a complete snapshot
    this.dirty.add(key)
    this.scheduleListFlush()
  }

  private scheduleListFlush(): void {
    if (this.listTimer || !this.listWatchers.size) return
    this.listTimer = setTimeout(() => {
      this.listTimer = null
      this.flushList()
    }, LIST_PUSH_MS)
  }

  private flushList(): void {
    const keys = [...this.dirty]
    this.dirty.clear()
    const removed = [...this.removedDirty]
    this.removedDirty.clear()
    if (!keys.length && !removed.length) return
    externalWatchTrace('flush', `keys=${keys.length} removed=${removed.length} listWatchers=${this.listWatchers.size}`)
    const pending = this.ui.pendingBySession()
    const summaries = keys
      .map((k) => this.rows.get(k))
      .filter((r): r is HostSessionRow => !!r && this.isAllowedProject(r.projectId))
      .map((r) => this.summaryFor(r, pending))
    for (const [client, filter] of this.listWatchers) {
      const mine = filter.projectId ? summaries.filter((s) => normalizeSessionFileKey(s.projectId) === normalizeSessionFileKey(filter.projectId!)) : summaries
      const gone = removed
        .filter(([, projectId]) => !filter.projectId || normalizeSessionFileKey(projectId) === normalizeSessionFileKey(filter.projectId))
        .map(([key]) => key)
      if (mine.length || gone.length) {
        client.sendEvent('sessions.update', { sessions: mine, ...(gone.length ? { removed: gone } : {}) })
        externalWatchTrace('flush', `pushed ${mine.length} summaries + ${gone.length} removals to a list watcher`)
      }
    }
  }

  /** A session was created remotely: make sure watchers see it right away. */
  announceSession(sessionFile: string, projectId: string): void {
    const key = normalizeSessionFileKey(sessionFile)
    // Provisional row right away; the file (and the real row) appears with the first reply.
    // provisionalUntil bounds the loadRows freshness-prune protection (iss_20261121165413).
    if (!this.rows.has(key)) this.rows.set(key, { sessionFile, projectId, title: '', createdAt: this.now(), updatedAt: this.now(), provisionalUntil: this.now() + ANNOUNCE_PENDING_MS })
    this.unlisted.set(key, projectId)
    this.markDirty(key)
  }

  // ── Timeline ──

  private async historyStamp(sessionFile: string): Promise<string> {
    try {
      const s = await stat(sessionFile)
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return `nostat:${this.now()}`
    }
  }

  private async loadHistoryTurns(entry: Entry, projectId: string): Promise<Turn[]> {
    const stamp = await this.historyStamp(entry.sessionFile)
    const cached = this.history.get(entry.key)
    if (cached && cached.stamp === stamp) return cached.turns
    let h: Awaited<ReturnType<RemoteHostPort['readHistory']>>
    try {
      h = await this.port.readHistory(projectId, entry.sessionFile)
    } catch (err) {
      // A brand-new session has no file until its first reply: that is an empty timeline, not an error.
      if (stamp.startsWith('nostat:')) return []
      throw err
    }
    const turns = projectHistory(h.items, (tool) => this.port.toolCardFor(tool, projectId), { model: h.model, thinking: h.thinking })
    this.setHistoryCache(entry.key, stamp, turns)
    return turns
  }

  /** History cache with the shared 40-entry eviction — the external path must not bypass it
   *  (rows-based watching creates history for every allowed session; unbounded would balloon). */
  private setHistoryCache(key: string, stamp: string, turns: Turn[]): void {
    this.history.set(key, { stamp, turns })
    if (this.history.size > 40) this.history.delete(this.history.keys().next().value as string)
  }

  /** History with the live turn laid over it (live wins for the same anchor). */
  private mergedTurns(entry: Entry, history: Turn[]): Turn[] {
    const live = entry.projector.liveTurn
    if (!live) return history
    const i = history.findIndex((t) => t.anchor === live.anchor)
    if (i >= 0) {
      const out = history.slice()
      out[i] = live
      return out
    }
    return [...history, live]
  }

  async open(client: HubClient, sessionKey: string, cursor?: Cursor): Promise<OpenResult> {
    const { entry, projectId } = await this.authorize(sessionKey)
    if (!entry.seeded) {
      entry.seeded = true
      // An external-running entry already carries the file-derived running state; probing the
      // (likely empty) slot pool here would clobber it to idle and hide Stop from the phone mid-run.
      if (!entry.externalRunning) {
        const st = await this.port.liveState(entry.sessionFile).catch(() => ({ running: false }))
        entry.projector.seedState(st)
      }
    }
    const title = this.rows.get(entry.key)?.title ?? ''
    // The raw sessionFile stays private to host I/O; every wire-facing session key is canonical.
    const base = { sessionKey: entry.key, title, epoch: this.epoch }

    if (cursor && cursor.epoch === this.epoch) {
      const oldest = entry.ring[0]?.seq
      const canReplay = cursor.seq === entry.seq || (oldest !== undefined && oldest <= cursor.seq + 1 && cursor.seq <= entry.seq)
      if (canReplay) {
        const patches = entry.ring.filter((p) => p.seq > cursor.seq)
        this.subscribe(client, entry)
        return { ...base, seq: entry.seq, kind: 'replay', patches, state: entry.projector.sessionState, pendingUi: this.ui.pendingFor(entry.key) }
      }
    }

    const history = await this.loadHistoryTurns(entry, projectId)
    // No await between merging the live turn and subscribing: every patch after `seq` reaches the client.
    const turns = this.mergedTurns(entry, history)
    // A snapshot is also a publish path. Seed the per-entry baseline from the full authoritative
    // projection (the response itself is paged); otherwise the first watcher tick would append
    // every older turn after the visible tail and scramble timeline order on clients.
    if (!entry.lastPublishedTurns) entry.lastPublishedTurns = structuredClone(turns)
    this.subscribe(client, entry)
    const resync = cursor ? (cursor.epoch !== this.epoch ? 'epoch_changed' : entry.ring.length >= RING_MAX ? 'evicted' : 'gap') : undefined
    return {
      ...base,
      seq: entry.seq,
      kind: 'snapshot',
      ...(resync ? { resync } : {}),
      turns: turns.slice(-PAGE_SIZE),
      hasOlder: turns.length > PAGE_SIZE,
      state: entry.projector.sessionState,
      pendingUi: this.ui.pendingFor(entry.key),
    }
  }

  private subscribe(client: HubClient, entry: Entry): void {
    for (const e of this.entries.values()) if (e !== entry) e.subscribers.delete(client)
    entry.subscribers.add(client)
  }

  close(client: HubClient, sessionKey: string): void {
    this.entries.get(normalizeSessionFileKey(sessionKey))?.subscribers.delete(client)
  }

  detach(client: HubClient): void {
    this.listWatchers.delete(client)
    for (const e of this.entries.values()) e.subscribers.delete(client)
  }

  /** Rewind the session, then have every viewer re-open it (its turns changed under them). */
  async rewind(sessionKey: string, anchor: string): Promise<{ editorText?: string }> {
    const { entry, projectId } = await this.authorize(sessionKey)
    if (entry.projector.sessionState.running) throw new RpcFail('busy', 'stop the run before rewinding')
    if (anchor.startsWith('live:')) throw new RpcFail('conflict', 'message is not saved yet')
    const r = await this.port.rewind(entry.sessionFile, anchor, projectId)
    this.branchMoved(entry)
    return r
  }

  /** The leaf moved (rewind, branch switch): every viewer re-opens. */
  private branchMoved(entry: Entry): void {
    // The leaf lives outside the JSONL, so the file stamp would not invalidate the cache.
    this.history.delete(entry.key)
    entry.projector.clearLiveTurn()
    this.publish(entry, [{ op: 'timeline.reset' }])
    this.port.notifySettingsChanged('rewound', entry.sessionFile)
  }

  async branches(sessionKey: string): Promise<{ branches: BranchInfo[] }> {
    const { entry, projectId } = await this.authorize(sessionKey)
    const tree = await this.port.sessionTree(entry.sessionFile, projectId)
    return { branches: branchesFromTree(tree.rows, tree.leafId) }
  }

  async switchBranch(sessionKey: string, leafId: string): Promise<Record<string, never>> {
    const { entry, projectId } = await this.authorize(sessionKey)
    if (entry.projector.sessionState.running) throw new RpcFail('busy', 'stop the run before switching branches')
    const tree = await this.port.sessionTree(entry.sessionFile, projectId)
    if (!tree.rows.some((r) => r.id === leafId)) throw new RpcFail('not_found', 'branch not found')
    await this.port.switchBranch(entry.sessionFile, leafId, projectId)
    this.branchMoved(entry)
    return {}
  }

  async fork(sessionKey: string, anchor: string): Promise<{ sessionKey: string; editorText?: string }> {
    const { entry, projectId } = await this.authorize(sessionKey)
    if (entry.projector.sessionState.running) throw new RpcFail('busy', 'stop the run before forking')
    if (anchor.startsWith('live:')) throw new RpcFail('conflict', 'message is not saved yet')
    const r = await this.port.fork(entry.sessionFile, anchor, projectId)
    this.announceSession(r.sessionFile, projectId)
    return { sessionKey: normalizeSessionFileKey(r.sessionFile), ...(r.editorText ? { editorText: r.editorText } : {}) }
  }

  async page(sessionKey: string, before: string, limit: number): Promise<{ turns: Turn[]; hasOlder: boolean }> {
    const { entry, projectId } = await this.authorize(sessionKey)
    const turns = this.mergedTurns(entry, await this.loadHistoryTurns(entry, projectId))
    const idx = turns.findIndex((t) => t.anchor === before)
    if (idx < 0) throw new RpcFail('not_found', 'anchor not found')
    const start = Math.max(0, idx - limit)
    return { turns: turns.slice(start, idx), hasOlder: start > 0 }
  }

  async toolDetail(sessionKey: string, toolCallId: string): Promise<{ node: import('@shared/remote').RenderNode; output?: string }> {
    const { entry, projectId } = await this.authorize(sessionKey)
    const turns = this.mergedTurns(entry, await this.loadHistoryTurns(entry, projectId))
    for (let i = turns.length - 1; i >= 0; i--) {
      const step = turns[i].steps.find((s) => s.kind === 'tool' && s.toolCallId === toolCallId)
      if (step?.kind === 'tool') {
        const output = entry.outputs.get(toolCallId) ?? step.node.preview
        return { node: step.node, ...(output ? { output } : {}) }
      }
    }
    throw new RpcFail('not_found', 'tool call not found')
  }

  /** `review.diff`: the working tree (git) or one turn's edit / write calls, as display lines. */
  async reviewDiff(
    sessionKey: string,
    scope: 'git' | 'turn',
    turnId: string | undefined,
    path: string | undefined,
  ): Promise<{ isRepo: boolean; branch?: string; files: DiffFile[]; file?: { path: string; lines: DiffLine[]; truncated: boolean }; message?: string }> {
    const { entry, projectId } = await this.authorize(sessionKey)
    let files: ParsedDiffFile[]
    let head: { isRepo: boolean; branch?: string; message?: string } = { isRepo: true }
    if (scope === 'git') {
      const g = await this.port.gitDiff(projectId)
      head = { isRepo: g.isRepo, ...(g.branch ? { branch: g.branch } : {}), ...(g.message ? { message: g.message } : {}) }
      files = parseUnifiedDiff(g.raw)
    } else {
      const turns = this.mergedTurns(entry, await this.loadHistoryTurns(entry, projectId))
      const turn = turnId ? turns.find((t) => t.id === turnId) : turns[turns.length - 1]
      if (!turn) throw new RpcFail('not_found', 'turn not found')
      files = turnChanges(turn)
    }
    const list = files.map(({ lines: _l, ...f }) => f)
    if (path === undefined) return { ...head, files: list }
    const hit = files.find((f) => f.path === path)
    if (!hit) throw new RpcFail('not_found', 'file has no changes')
    return { ...head, files: list, file: { path, ...capLines(hit.lines) } }
  }
}

/** One turn's edit / write calls per file, in order (the timeline's `files` stats use the same calls). */
function turnChanges(turn: Turn): ParsedDiffFile[] {
  const byPath = new Map<string, ParsedDiffFile>()
  for (const step of turn.steps) {
    if (step.kind !== 'tool' || step.status === 'error') continue
    const node = step.node
    if (node.template !== 'edit' && node.template !== 'write') continue
    const path = typeof node.fields.path === 'string' ? node.fields.path : ''
    if (!path) continue
    const f = byPath.get(path) ?? { path, add: 0, del: 0, status: node.template === 'write' ? ('added' as const) : ('modified' as const), lines: [] }
    const lines =
      node.template === 'write'
        ? (node.preview ?? '').split('\n').map((s, i): DiffLine => ({ k: 'add', n: i + 1, s }))
        : parsePiDiff(node.preview ?? '')
    if (f.lines.length && lines.length) f.lines.push({ k: 'gap', s: '' })
    f.lines.push(...lines)
    f.add += typeof node.fields.add === 'number' ? node.fields.add : lines.filter((l) => l.k === 'add').length
    f.del += typeof node.fields.del === 'number' ? node.fields.del : lines.filter((l) => l.k === 'del').length
    if (node.detail) f.lines.push({ k: 'gap', s: '…' })
    byPath.set(path, f)
  }
  return [...byPath.values()]
}

/** A turn clients have not seen in this exact shape yet (status / step count / answer changed). */
function externalTurnChanged(prev: Turn, turn: Turn): boolean {
  return prev.status !== turn.status || prev.steps.length !== turn.steps.length || prev.answer !== turn.answer
}

/** mtime half of a `mtimeMs:size` stamp; undefined for the `nostat:` fallback. */
function stampEpochMs(stamp: string): number | undefined {
  const v = Number(stamp.split(':')[0])
  return Number.isFinite(v) ? v : undefined
}

/** Stop reasons that close a turn; `toolUse` only closes one assistant message, not the turn. */
function externalTerminalOutcome(item: HostTimelineItem | undefined): 'success' | 'failed' | 'cancelled' | null {
  if (item?.type !== 'assistant-message') return null
  if (item.stopReason === 'stop' || item.stopReason === 'length') return 'success'
  if (item.stopReason === 'error' || item.stopReason === 'interrupted') return 'failed'
  if (item.stopReason === 'aborted') return 'cancelled'
  return null
}

/** Bounded preview for synthesized completion notifications. */
function clampPreview(text: string | undefined, max = 200): string | undefined {
  const t = (text ?? '').trim()
  return t ? t.slice(0, max) : undefined
}
