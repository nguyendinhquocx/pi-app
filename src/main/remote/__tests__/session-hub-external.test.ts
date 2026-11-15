import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppEvent } from '@shared/app-events'
import type { TurnPatch } from '@shared/remote'
import { normalizeSessionFileKey } from '@shared/session-file-key'
import { UiRouter } from '../ui-router'
import type { HubClient } from '../session-hub'
import { SessionHub } from '../session-hub'
import { FakeHost } from '../testing/fake-host'
import { registeredExternalChangeTargetCount, startSessionFileWatcher, stopSessionFileWatcher } from '../session-file-watcher'
import type { HostTimelineItem } from '../host-port'

/**
 * External (file-watcher) reconcile over a FakeHost plus REAL temp files, so stamps carry a
 * real mtime: running derivation depends on file inactivity, not just item shapes.
 */

let dir: string
let host: FakeHost
let ui: UiRouter
let hub: SessionHub
let clock = 0
let fileSeq = 0
const now = (): number => clock

class FakeClient implements HubClient {
  readonly id: string
  readonly events: Array<{ m: string; p: unknown }> = []
  readonly patches: TurnPatch[] = []
  constructor(id: string) {
    this.id = id
  }
  sendEvent(m: string, p: unknown): void {
    this.events.push({ m, p })
  }
  queuePatches(_key: string, patches: TurnPatch[]): void {
    this.patches.push(...patches)
  }
}

function mkItems(turns: Array<{ user: string; answer?: string; stop?: boolean; entryId?: string; tools?: string[] }>): HostTimelineItem[] {
  const items: HostTimelineItem[] = []
  let e = 0
  for (const t of turns) {
    const entryId = t.entryId ?? `e${++e}`
    items.push({ id: `h-${entryId}`, type: 'user-message', text: t.user, sessionEntryId: entryId, timestamp: 1000 + e })
    for (const tool of t.tools ?? []) {
      items.push({ id: `h-${entryId}-t${items.length}`, type: 'tool-call', toolCallId: `call-${entryId}-${items.length}`, toolName: tool, toolArgs: {}, toolOutput: 'ok', timestamp: 1000 + e })
    }
    if (t.answer !== undefined) {
      items.push({
        id: `h-${entryId}-a`,
        type: 'assistant-message',
        text: t.answer,
        sessionEntryId: `${entryId}-a`,
        timestamp: 1000 + e,
        ...(t.stop === false ? {} : { stopReason: 'stop' }),
      })
    }
  }
  return items
}

/** Register a session on the fake host AND create the real file (with explicit mtime) for stats. */
async function addSession(items: HostTimelineItem[], mtimeMs: number): Promise<string> {
  const projectId = dir
  const file = join(projectId, '.pi', 'sessions', `ext-${++fileSeq}.jsonl`)
  host.sessions.set(file, {
    row: { sessionFile: file, projectId, title: 'ext', createdAt: 1, updatedAt: 1, firstMessage: items[0]?.text },
    items,
    running: false,
    model: 'm',
    thinking: 'high',
  })
  await mkdir(join(projectId, '.pi', 'sessions'), { recursive: true })
  await writeFile(file, items.map((i) => JSON.stringify(i)).join('\n') || '\n', 'utf8')
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs))
  return file
}

async function touch(file: string, items: HostTimelineItem[], mtimeMs: number): Promise<void> {
  const s = host.sessions.get(file)
  if (s) s.items = items
  await writeFile(file, items.map((i) => JSON.stringify(i)).join('\n'), 'utf8')
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs))
}

function slotEvent(file: string, partial: Partial<AppEvent> & Pick<AppEvent, 'type'>): AppEvent {
  return { seq: 1, workspaceId: dir, sessionFile: file, timestamp: clock, ...partial } as AppEvent
}

const upserts = (client: FakeClient): Array<Extract<TurnPatch, { op: 'turn.upsert' }>> =>
  client.patches.filter((p): p is Extract<TurnPatch, { op: 'turn.upsert' }> => p.op === 'turn.upsert')
const resets = (client: FakeClient): Array<Extract<TurnPatch, { op: 'timeline.reset' }>> =>
  client.patches.filter((p): p is Extract<TurnPatch, { op: 'timeline.reset' }> => p.op === 'timeline.reset')
const settles = (client: FakeClient): Array<Extract<TurnPatch, { op: 'turn.settle' }>> =>
  client.patches.filter((p): p is Extract<TurnPatch, { op: 'turn.settle' }> => p.op === 'turn.settle')

/** Keep the external callback result protocol out of the behavior-focused assertions. */
async function reconcile(file: string) {
  const result = await hub.onExternalChange(file)
  return result.status === 'processed' ? result.signal ?? null : null
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lix-hub-ext-'))
  host = new FakeHost({ projects: [dir] })
  ui = new UiRouter(host, () => {})
  hub = new SessionHub(host, ui, () => [dir], now)
  clock = 1000
})

afterEach(async () => {
  hub.dispose()
  hub.disposeExternalWatch()
  host.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('SessionHub external reconcile', () => {
  it('a snapshot seeds the full baseline so the first watcher tick never appends older turns after the tail', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }, { user: 'go', answer: 'done' }]), 1000)
    const client = new FakeClient('c1')
    const open = await hub.open(client, file)
    expect(open.kind).toBe('snapshot')
    expect(open.turns?.map((t) => t.user.text)).toEqual(['hi', 'go'])

    const signal = await reconcile(file)
    expect(signal).toEqual({ sessionFile: file, running: false })
    // Snapshot already gave these turns; watcher must not append duplicate/older upserts.
    expect(upserts(client)).toHaveLength(0)
  })

  it('an entry with no prior snapshot seeds an empty baseline by publishing all turns once', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }, { user: 'go', answer: 'done' }]), 1000)
    const signal = await reconcile(file)
    expect(signal?.running).toBe(false)
    // No client had a snapshot: first reconcile publishes the full state to the ring.
    const entryClient = new FakeClient('c1')
    const open = await hub.open(entryClient, file, { epoch: hub.epoch, seq: 0 })
    expect(open.kind).toBe('replay')
    const patches = (open as { patches?: TurnPatch[] }).patches ?? []
    expect(patches.filter((p) => p.op === 'turn.upsert')).toHaveLength(2)
  })

  it('a new turn in the file publishes exactly one upsert for that turn', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }]), 1000)
    const client = new FakeClient('c1')
    await hub.open(client, file)
    await reconcile(file) // seed baseline
    client.patches.length = 0

    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'more', answer: 'second' }]), 4000)
    clock = 4000
    const signal = await reconcile(file)
    expect(signal?.running).toBe(false)
    expect(upserts(client)).toHaveLength(1)
    expect(upserts(client)[0].turn.user.text).toBe('more')
  })

  it('an edited turn publishes one upsert, no reset (anchor still present)', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }]), 1000)
    const client = new FakeClient('c1')
    await hub.open(client, file)
    await reconcile(file)
    client.patches.length = 0

    await touch(file, mkItems([{ user: 'hi', answer: 'hello EDITED with tools', tools: ['read'] }]), 4000)
    clock = 4000
    await reconcile(file)
    expect(resets(client)).toHaveLength(0)
    expect(upserts(client)).toHaveLength(1)
  })

  it('a structural change (history shrank / anchor vanished) publishes timeline.reset', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }, { user: 'go', answer: 'done' }]), 1000)
    const client = new FakeClient('c1')
    await hub.open(client, file)
    await reconcile(file) // baseline has 2 turns
    client.patches.length = 0

    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }]), 4000) // rewound: 1 turn left
    clock = 4000
    await reconcile(file)
    expect(resets(client)).toHaveLength(1)
    expect(upserts(client)).toHaveLength(0)
    // The baseline now mirrors the reset state: the next reconcile publishes nothing.
    client.patches.length = 0
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }]), 5000)
    clock = 5000
    await reconcile(file)
    expect(client.patches).toHaveLength(0)
  })

  it('skips the entry while a slot is actively streaming (running), then recovers after 60s', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }]), 1000)
    const client = new FakeClient('c1')
    await hub.open(client, file)
    await reconcile(file)
    client.patches.length = 0

    // Slot takes over at t=2000.
    hub.onAppEvent(slotEvent(file, { type: 'run', phase: 'running' }))
    client.patches.length = 0
    clock = 2500
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'slot', answer: 'slot work', stop: false }]), 2500)
    const skipped = await reconcile(file)
    expect(skipped).toBeNull()
    expect(client.patches).toHaveLength(0)

    // Slot quiet for >60s (crashed without an idle event): external reconciles from disk.
    clock = 62_000
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'slot', answer: 'slot work' }]), 62_000)
    const signal = await reconcile(file)
    expect(signal).not.toBeNull()
    expect(upserts(client)).toHaveLength(1) // the slot turn, now complete on disk
  })

  it('keeps a live slot protected after 60s silence and only recovers once the worker is gone', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }]), 1000)
    const stored = host.sessions.get(file)
    if (!stored) throw new Error('test session missing')
    stored.running = true
    const client = new FakeClient('c1')
    const open = await hub.open(client, file)
    expect(open.state?.running).toBe(true)
    expect(await reconcile(file)).toBeNull() // authoritative liveState protects the slot
    client.patches.length = 0

    hub.onAppEvent(slotEvent(file, { type: 'run', phase: 'running' }))
    client.patches.length = 0
    clock = 2500
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'slot', answer: 'thinking', stop: false }]), 2500)
    expect(await reconcile(file)).toBeNull() // recent slot event

    clock = 62_500 // >60s event silence and >90s of external-running threshold
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'slot', answer: 'still thinking', stop: false }]), 62_500)
    expect(await reconcile(file)).toBeNull() // worker is still live; do not clear its live turn
    expect(client.patches).toHaveLength(0)

    stored.running = false // slot crashed; no worker owns the file now
    clock = 63_000
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'slot', answer: 'finished on disk' }]), 63_000)
    const recovered = await reconcile(file)
    expect(recovered?.running).toBe(false)
    expect(upserts(client).some((p) => p.turn.answer === 'finished on disk')).toBe(true)
  })

  it('skips while a live turn is open, and right after a slot settle (no duplicate publish)', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }]), 1000)
    const client = new FakeClient('c1')
    await hub.open(client, file)
    await reconcile(file)
    client.patches.length = 0

    hub.onAppEvent(slotEvent(file, { type: 'run', phase: 'running' }))
    hub.onAppEvent(slotEvent(file, { type: 'message', role: 'user', phase: 'start', text: 'live' }))
    hub.onAppEvent(slotEvent(file, { type: 'message', role: 'user', phase: 'end', sessionEntryId: 'e2' }))
    hub.onAppEvent(slotEvent(file, { type: 'message', role: 'assistant', phase: 'delta', text: 'pending', contentKind: 'text' }))
    clock = 2000
    // Live turn is open (running): external file change is skipped.
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'live', answer: 'pending', stop: false }]), 2000)
    expect(await reconcile(file)).toBeNull()

    // Slot settles properly (idle event): baseline already carries the settle.
    hub.onAppEvent(slotEvent(file, { type: 'run', phase: 'idle', settled: true }))
    client.patches.length = 0
    clock = 2500
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'live', answer: 'pending' }]), 2500)
    expect(await reconcile(file)).toBeNull() // 60s window after the settle
    expect(client.patches).toHaveLength(0) // no duplicate publish

    clock = 61_500 // window over: reconcile runs, content matches the baseline → no patches
    await reconcile(file)
    expect(client.patches).toHaveLength(0)
  })

  it('a slot turn that never sent idle (crash) settles from disk after the window', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }]), 1000)
    const client = new FakeClient('c1')
    await hub.open(client, file)
    await reconcile(file)
    client.patches.length = 0

    // Phone started a slot turn; worker wrote the assistant leaf then crashed (no idle event).
    hub.onAppEvent(slotEvent(file, { type: 'run', phase: 'running' }))
    hub.onAppEvent(slotEvent(file, { type: 'message', role: 'user', phase: 'start', text: 'from phone' }))
    hub.onAppEvent(slotEvent(file, { type: 'message', role: 'user', phase: 'end', sessionEntryId: 'e2' }))
    clock = 2000
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'from phone', answer: 'written then crashed' }]), 2000)

    client.patches.length = 0 // count only what THIS reconcile publishes
    clock = 62_000
    const signal = await reconcile(file)
    expect(signal?.running).toBe(false)
    expect(settles(client)).toHaveLength(1)
    expect(settles(client)[0].status).toBe('done')
    expect(upserts(client)).toHaveLength(1) // authoritative final text missing from the live slot baseline
    expect(upserts(client)[0].turn.answer).toBe('written then crashed')
    // The stale running flag is also cleared on the wire (full state publish).
    const state = client.patches.find((p) => p.op === 'session.state')
    expect(state && state.op === 'session.state' && state.state.running).toBe(false)
  })

  it('open/enrich reads do not break the baseline (history cache eviction)', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }]), 1000)
    const client = new FakeClient('c1')
    await hub.open(client, file)
    await reconcile(file) // seed baseline for our entry
    client.patches.length = 0

    // Force >40 other entries through loadHistoryTurns so the history cache evicts ours.
    const other = new FakeClient('c2')
    for (let i = 0; i < 45; i++) {
      const f = await addSession(mkItems([{ user: `t${i}`, answer: `a${i}` }]), 1000 + i)
      await hub.open(other, f)
    }

    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'new', answer: 'fresh' }]), 5000)
    clock = 5000
    await reconcile(file)
    expect(upserts(client)).toHaveLength(1) // baseline survived the eviction: only the new turn
    expect(upserts(client)[0].turn.user.text).toBe('new')
  })

  it('warm reconnect after no subscribers replays the ring fed by external changes', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }]), 1000)
    const a = new FakeClient('a')
    const openA = await hub.open(a, file)
    expect(openA.kind).toBe('snapshot')
    await reconcile(file) // baseline seed
    const cursorSeq = a.patches.at(-1)?.seq ?? openA.seq
    a.patches.length = 0

    hub.close(a, file) // phone leaves; the entry (and ring) stays in the map
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'quiet1', answer: 'one' }]), 4000)
    clock = 4000
    await reconcile(file)
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'quiet1', answer: 'one' }, { user: 'quiet2', answer: 'two' }]), 5000)
    clock = 5000
    await reconcile(file)

    const b = new FakeClient('b')
    const openB = await hub.open(b, file, { epoch: hub.epoch, seq: cursorSeq })
    expect(openB.kind).toBe('replay')
    const patches = (openB as { patches?: TurnPatch[] }).patches ?? []
    expect(patches.filter((p) => p.op === 'turn.upsert')).toHaveLength(2) // quiet1 + quiet2 replayed
  })

  describe('running derivation (raw items + mtime)', () => {
    it('user-only turn tail with a fresh mtime is running', async () => {
      const file = await addSession(mkItems([{ user: 'typing…', answer: undefined }]), 1000)
      const client = new FakeClient('c1')
      await hub.open(client, file)
      clock = 3000
      const signal = await reconcile(file)
      expect(signal?.running).toBe(true)
    })

    it('tool-call tail mid-turn with a fresh mtime is running', async () => {
      const file = await addSession(mkItems([{ user: 'work', answer: undefined, tools: ['bash'] }]), 1000)
      const client = new FakeClient('c1')
      await hub.open(client, file)
      clock = 3000
      const signal = await reconcile(file)
      expect(signal?.running).toBe(true)
    })

    it('a terminal assistant tail is idle', async () => {
      const file = await addSession(mkItems([{ user: 'hi', answer: 'done' }]), 1000)
      const client = new FakeClient('c1')
      await hub.open(client, file)
      clock = 3000
      const signal = await reconcile(file)
      expect(signal?.running).toBe(false)
    })

    it('a non-terminal tail with >90s of inactivity is idle (crash backstop)', async () => {
      const file = await addSession(mkItems([{ user: 'work', answer: undefined, tools: ['bash'] }]), 1000)
      const client = new FakeClient('c1')
      await hub.open(client, file)
      clock = 91_500 // file mtime=1000: silent for >90s
      const signal = await reconcile(file)
      expect(signal?.running).toBe(false)
    })

    it('re-evaluates every tick while running and flips to idle after silence (>90s)', async () => {
      const file = await addSession(mkItems([{ user: 'work', answer: undefined, tools: ['bash'] }]), 1000)
      const client = new FakeClient('c1')
      await hub.open(client, file)
      clock = 3000
      expect((await reconcile(file))?.running).toBe(true)

      // No file change at all: the tick still re-evaluates from the cached raw items + stamp.
      clock = 5000
      const ticks = await hub.onWatchTick(new Map())
      expect(ticks).toEqual([]) // still running, nothing flipped

      clock = 91_500 // silence crossed the backstop
      const flipped = await hub.onWatchTick(new Map())
      expect(flipped).toEqual([{ sessionFile: file, running: false }])
      // The LAST full-state patch is the flip: running=false (earlier patches carried running=true).
      const states = client.patches.filter((p) => p.op === 'session.state')
      const last = states.at(-1)
      expect(last && last.op === 'session.state' && last.state.running).toBe(false)
    })
  })

  it('a torn tail (unreadable file) skips the cycle without touching the baseline', async () => {
    const file = await addSession(mkItems([{ user: 'hi', answer: 'hello' }]), 1000)
    const client = new FakeClient('c1')
    await hub.open(client, file)
    await reconcile(file) // seed
    client.patches.length = 0

    host.unwritten.add(file) // FakeHost throws invalid_session = torn tail
    expect(await reconcile(file)).toBeNull()
    expect(client.patches).toHaveLength(0)
    host.unwritten.delete(file)

    // Baseline intact: the next good read only upserts the genuinely new turn.
    await touch(file, mkItems([{ user: 'hi', answer: 'hello' }, { user: 'after', answer: 'ok' }]), 4000)
    clock = 4000
    await reconcile(file)
    expect(upserts(client)).toHaveLength(1)
    expect(upserts(client)[0].turn.user.text).toBe('after')
  })

  it('dispose unregisters the watcher target', () => {
    const before = registeredExternalChangeTargetCount()
    const extra = new SessionHub(host, ui, () => [dir], now)
    expect(registeredExternalChangeTargetCount()).toBe(before + 1)
    extra.dispose()
    extra.disposeExternalWatch()
    expect(registeredExternalChangeTargetCount()).toBe(before)
  })

  it('observes a rows-only session (no entry, no visible) and processes its external change', async () => {
    // Regression for the 0.7.12 UAT failure: the watcher only polled hub entries + the visible
    // session, so a TUI session nobody had opened (no entry) was never watched.
    const file = await addSession(mkItems([{ user: 'q', answer: 'a' }]), 1000)
    await hub.listSummaries() // fills rows via loadRows; creates no entries
    const seen: string[] = []
    const w = startSessionFileWatcher((s) => seen.push(s.sessionFile))
    try {
      clock += 2000
      await touch(file, mkItems([{ user: 'q', answer: 'a' }, { user: 'q2', answer: 'a2' }]), clock)
      await w.tick()
      expect(seen).toContain(file)
    } finally {
      stopSessionFileWatcher()
    }
  })

  it('phone open() during an external run keeps running=true (no slot-probe clobber)', async () => {
    // Regression for GLM review finding 2: open() seeded state from the (empty) slot pool,
    // flipping a mid-run external session to idle and hiding Stop on the phone.
    const file = await addSession(mkItems([{ user: 'q', answer: 'working', stop: false }]), 1000)
    await hub.listSummaries()
    const key = normalizeSessionFileKey(file)
    const w = startSessionFileWatcher(() => {})
    try {
      await w.tick() // reconcile derives externalRunning=true (non-terminal tail, fresh mtime)
      const client = new FakeClient('open-mid-run')
      const opened = await hub.open(client, key)
      expect(opened.state.running).toBe(true)
      clock += 2000
      await w.tick() // watch tick must not flip it back either
      const again = await hub.open(client, key)
      expect(again.state.running).toBe(true)
    } finally {
      stopSessionFileWatcher()
    }
  })
})
