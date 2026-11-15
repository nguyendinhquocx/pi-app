import { stat } from 'node:fs/promises'
import { normalizeSessionFileKey } from '@shared/session-file-key'

/**
 * App-level poller for pi session files written OUTSIDE the app (e.g. the `li` TUI in a
 * terminal). Slot workers report through AppEvents; this service is the missing half: it
 * stat-polls the files the SessionHub knows about (plus the session the renderer is showing)
 * and hands each observed stamp change to the hub for reconcile-publish. It intentionally
 * shares no lifecycle with the Remote Gateway: remote sync can be off and external sessions
 * must still live-update the desktop renderer.
 */

/** What a reconcile produced for the renderer: the file changed and its heuristic run state. */
export type SessionFileChangeSignal = {
  sessionFile: string
  running: boolean
}

/**
 * Distinguishes a successful read (commit stamp), a failed/torn read (retry after the gate), and
 * arbitration defer (no read happened; re-check each poll tick without consuming the 5s gate).
 */
export type ExternalChangeResult =
  | { status: 'processed'; signal?: SessionFileChangeSignal }
  | { status: 'retry' }
  | { status: 'deferred' }

/** The hub side of the contract: what to watch and what to do when a stamp changes. */
export interface ExternalChangeTarget {
  /** Raw session file paths to stat-poll (hub entries ∪ list rows ∪ visible session). */
  observedSessionFiles(): string[]
  /** The observed stamp changed: reconcile from disk. */
  onExternalChange(sessionFile: string): Promise<ExternalChangeResult>
  /** Every poll tick, even without stamp changes: re-evaluate running heuristics. */
  onWatchTick(stamps: ReadonlyMap<string, string>): Promise<SessionFileChangeSignal[]>
}

const POLL_MS = 3000
/** At most one full re-read + parse per file per 5s, even under continuous writes. */
const REREAD_GATE_MS = 5000
/** Reconciles (full reads) per tick: bounds a large rows seed to a drain over several ticks,
 *  newest sessions first, so a startup flood cannot starve live sessions. */
const MAX_RECONCILES_PER_TICK = 12
/** A hung stat/WSL path must not stall the whole watcher loop. */
const STAT_TIMEOUT_MS = 10_000
const RECONCILE_TIMEOUT_MS = 30_000

/**
 * UAT diagnostics (PI_EXT_WATCH_TRACE=1): main wires this to electron-log; a no-op by default so
 * the watcher/hub stay electron-free. Repeated identical keys log once, then every 10th occurrence,
 * so a stuck defer/retry loop is visible without flooding the log.
 */
const noopTrace = () => {}
let traceSink: (line: string) => void = noopTrace
let traceActive = false
const traceCounts = new Map<string, number>()

export function setExternalWatchTrace(fn: (line: string) => void): void {
  traceSink = fn
  traceActive = fn !== noopTrace
  traceCounts.clear()
}

export function externalWatchTrace(key: string, line: string): void {
  if (!traceActive) return // don't even count when tracing is off
  const n = (traceCounts.get(key) ?? 0) + 1
  traceCounts.set(key, n)
  if (n === 1 || n % 10 === 0) traceSink(`[${key} #${n}] ${line}`)
}

/** Never let one slow/hung I/O path stall the whole poll loop: race against a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback())
      },
    )
  })
}

/**
 * SessionHub (and any future source) registers itself here at construction. The registry is
 * module-level so a hub created before the watcher starts (lazy gateway) is still picked up.
 */
const targets = new Set<ExternalChangeTarget>()

export function registerExternalChangeTarget(target: ExternalChangeTarget): () => void {
  targets.add(target)
  return () => {
    targets.delete(target)
  }
}

/** Test/inspection seam: how many live targets the watcher would poll. */
export function registeredExternalChangeTargetCount(): number {
  return targets.size
}

type FileWatchState = {
  /** Stamp the file was last re-read with; also the "anything new?" reference. */
  lastRereadStamp?: string
  /** When the re-read gate was last consumed (only when a DIFFERENT stamp was read); null = never. */
  lastRereadAt: number | null
}

export class SessionFileWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly states = new Map<string, FileWatchState>()
  private polling = false

  constructor(
    private readonly emit: (signal: SessionFileChangeSignal) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), POLL_MS)
    // Never keep the process alive just for polling (matters for CLI-ish embedders).
    this.timer.unref?.()
    externalWatchTrace('lifecycle', `watcher started (poll=${POLL_MS}ms)`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.states.clear()
  }

  dispose(): void {
    this.stop()
  }

  /** One poll cycle; public so tests drive it without waiting for the interval. */
  async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.pollOnce()
    } finally {
      this.polling = false
    }
  }

  private async pollOnce(): Promise<void> {
    const stamps = new Map<string, string>()
    const rawPaths = new Map<string, string>()
    for (const target of targets) {
      for (const file of target.observedSessionFiles()) {
        const key = normalizeSessionFileKey(file)
        if (!key || rawPaths.has(key)) continue
        rawPaths.set(key, file)
        const stamp = await withTimeout(this.stampOf(file), STAT_TIMEOUT_MS, () => null)
        if (stamp) stamps.set(key, stamp)
        else externalWatchTrace('stat:' + key, 'stat failed or timed out')
      }
    }
    // States for files no longer observed would otherwise linger forever (gate + pending stamps).
    for (const k of [...this.states.keys()]) if (!stamps.has(k)) this.states.delete(k)
    externalWatchTrace('tick', `targets=${targets.size} observed=${stamps.size}`)

    const signals: SessionFileChangeSignal[] = []

    // Collect changed stamps first, then reconcile NEWEST-first with a per-tick budget: the first
    // observation of a large rows set would otherwise full-read every file in ONE tick (startup
    // flood). Budgeting spreads the seed drain over ticks while active sessions keep priority.
    const changes: Array<{ key: string; stamp: string; file: string; target: ExternalChangeTarget; mtimeMs: number }> = []
    for (const target of targets) {
      for (const [key, stamp] of stamps) {
        const state = this.stateFor(key)
        if (state.lastRereadStamp === stamp) continue // nothing new on disk
        if (state.lastRereadAt !== null && this.now() - state.lastRereadAt < REREAD_GATE_MS) continue // gate closed; retry next tick
        changes.push({ key, stamp, file: rawPaths.get(key) as string, target, mtimeMs: Number(stamp.slice(0, stamp.indexOf(':'))) || 0 })
      }
    }
    changes.sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (changes.length > MAX_RECONCILES_PER_TICK) {
      externalWatchTrace('budget', `${changes.length} changed; reconciling ${MAX_RECONCILES_PER_TICK} newest, deferring ${changes.length - MAX_RECONCILES_PER_TICK}`)
    }
    for (const { key, stamp, file, target } of changes.slice(0, MAX_RECONCILES_PER_TICK)) {
      const state = this.stateFor(key)
      externalWatchTrace('change:' + key, `stamp changed -> ${stamp}`)
      let result: ExternalChangeResult
      try {
        result = await withTimeout(target.onExternalChange(file), RECONCILE_TIMEOUT_MS, () => ({ status: 'deferred' }))
      } catch (error) {
        // A throwing target must not kill the poll loop (other sessions still need live sync).
        externalWatchTrace('ext:' + key, `onExternalChange threw: ${String(error).slice(0, 120)}`)
        continue
      }
      if (result.status === 'deferred') continue // slot arbitration/timeout: no file read, so do not spend/commit the gate
      // Stat after the read: if the file moved underneath us, drop the signal — the next
      // cycle re-reads the newer stamp after the gate. Torn-tail failures also consume a gate
      // interval but deliberately do NOT commit the stamp, so they get retried.
      const after = await withTimeout(this.stampOf(file), STAT_TIMEOUT_MS, () => null)
      state.lastRereadAt = this.now()
      if (after !== stamp) {
        externalWatchTrace('gate:' + key, 'stamp moved during read; drop signal, retry next tick')
        continue
      }
      if (result.status === 'processed') {
        state.lastRereadStamp = stamp
        if (result.signal) signals.push(result.signal)
      }
      externalWatchTrace('ext:' + key, `onExternalChange -> ${result.status}${result.status === 'processed' && result.signal ? ` running=${result.signal.running}` : ''}`)
    }

    // Running re-evaluation runs every tick regardless of stamp changes (idle backstop).
    for (const target of targets) {
      try {
        signals.push(...(await withTimeout(target.onWatchTick(stamps), RECONCILE_TIMEOUT_MS, () => [])))
      } catch (error) {
        externalWatchTrace('watchtick', `onWatchTick threw: ${String(error).slice(0, 120)}`)
      }
    }
    for (const signal of signals) this.emit(signal)
  }

  private stateFor(key: string): FileWatchState {
    let s = this.states.get(key)
    if (!s) {
      s = { lastRereadAt: null }
      this.states.set(key, s)
    }
    return s
  }

  private async stampOf(file: string): Promise<string | null> {
    try {
      const s = await stat(file)
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return null
    }
  }
}

let shared: SessionFileWatcher | null = null

/** App lifetime: start the shared watcher once (main index.ts). */
export function startSessionFileWatcher(emit?: (signal: SessionFileChangeSignal) => void): SessionFileWatcher {
  if (!shared) shared = new SessionFileWatcher(emit)
  shared.start()
  return shared
}

export function stopSessionFileWatcher(): void {
  shared?.stop()
  shared = null
}
