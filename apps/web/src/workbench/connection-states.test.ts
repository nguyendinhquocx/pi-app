import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { base64UrlEncode, type Turn } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { HostConnection } from '../transport/host-connection'
import { encodeKeyPair, type DeviceKeyRecord } from '../transport/device-keys'
import { HostSim, testKeyPair } from '../test/host-sim'
import { connectStore, useWorkbench, activeSlice, openSessionInStore } from './workbench-store'

/**
 * Spec T4 UX contract states: loading/empty/error/disconnected/owner busy/handoff/stream —
 * surfaced per host slice; per-host session namespaces never merge.
 */

const HOST_STATIC = testKeyPair('bb'.repeat(32))

function makeDevice(hostId: string): DeviceKeyRecord {
  const kp = encodeKeyPair(generateKeyPair())
  return {
    hostId,
    hostName: hostId,
    hostPub: base64UrlEncode(HOST_STATIC.pub),
    ...kp,
    endpoints: [],
    createdAt: 1,
    lastConnectedAt: null,
    deviceId: null,
  }
}

const HELLO = (hostId: string) => ({
  hostId,
  hostName: hostId,
  version: '0.7.13',
  epoch: 'e_1',
  deviceId: 'dev_test',
  role: 'operator' as const,
  features: [],
  assets: [],
  ownerProtocol: 1,
})

const SESSIONS_BOTH_HOSTS = (hostId: string) => [
  { sessionKey: 'proj/shared-name.jsonl', projectId: 'p1', title: 'shared-name (' + hostId + ')', status: 'idle' as const, updatedAt: 1 },
]

function sessionOpenResult(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    sessionKey: 'proj/shared-name.jsonl',
    title: 'shared-name',
    epoch: 'e_1',
    seq: 7,
    kind: 'snapshot',
    turns: [],
    state: { running: false },
    pendingUi: [],
    ...overrides,
  }
}

function runningTurn(answer = 'partial'): Turn {
  return {
    id: 't-live',
    anchor: 'a-live',
    status: 'running',
    user: { text: 'question' },
    activity: { counts: { read: 0, edit: 0, write: 0, run: 0, search: 0, think: 0, other: 0 }, failed: 0 },
    steps: [],
    answer,
    files: [],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  useWorkbench.setState({ slices: {}, activeHostId: null, notice: null })
})

afterEach(() => {
  vi.useRealTimers()
})

async function onlineHost(hostId: string, extraHandlers: Record<string, (params: unknown) => unknown> = {}): Promise<{ conn: HostConnection; sim: HostSim }> {
  const sim = new HostSim({
    hostStatic: HOST_STATIC,
    hostId,
    handlers: {
      'host.hello': () => HELLO(hostId),
      'session.open': () => sessionOpenResult(),
      'session.watchList': () => ({ sessionKeys: [] }),
      'session.unwatchList': () => ({}),
      'session.stats': () => ({ context: null, usage: null }),
      ...extraHandlers,
    },
  })
  const conn = new HostConnection({
    endpoint: 'wss://x.tail1234.ts.net/ws',
    device: makeDevice(hostId),
    socketFactory: () => sim.newSocket() as unknown as WebSocket,
    backoff: { baseMs: 100, factor: 2, capMs: 1000, jitter: 0, rng: () => 0.5 },
  })
  connectStore(conn, hostId)
  conn.start()
  sim.socket.open()
  await vi.advanceTimersByTimeAsync(0)
  return { conn, sim }
}

describe('workbench store — connection states & host isolation (spec T4)', () => {
  it('state flows into the slice: connecting → handshaking → online, hello fills role + ownerProtocol', async () => {
    const { conn } = await onlineHost('host_1')
    expect(conn.online).toBe(true)
    const slice = activeSlice({ ...useWorkbench.getState(), activeHostId: 'host_1' })
    expect(slice?.state).toBe('online')
    expect(slice?.role).toBe('operator')
    expect(slice?.ownerProtocol).toBe(1)
  })

  it('same session path on two hosts never merges (separate namespaces)', async () => {
    await onlineHost('host_A')
    await onlineHost('host_B')

    // Both hosts push a session update for the SAME session path.
    useWorkbench.getState().setSessions('host_A', SESSIONS_BOTH_HOSTS('host_A'))
    useWorkbench.getState().setSessions('host_B', SESSIONS_BOTH_HOSTS('host_B'))

    // Open the same-named session on both; timelines are separate objects.
    const s = useWorkbench.getState()
    s.selectSession('host_A', 'proj/shared-name.jsonl')
    s.selectSession('host_B', 'proj/shared-name.jsonl')
    s.setTimeline('host_A', 'proj/shared-name.jsonl', { turns: [], seq: 3, state: { running: false }, pendingUi: [], hasOlder: false })
    s.setTimeline('host_B', 'proj/shared-name.jsonl', { turns: [], seq: 9, state: { running: true }, pendingUi: [], hasOlder: false })

    const now = useWorkbench.getState()
    expect(now.slices['host_A'].timelines['proj/shared-name.jsonl'].seq).toBe(3)
    expect(now.slices['host_B'].timelines['proj/shared-name.jsonl'].seq).toBe(9)
    expect(now.slices['host_B'].timelines['proj/shared-name.jsonl'].state.running).toBe(true)
    // Active host switch flips what the UI renders.
    now.setActiveHost('host_A')
    expect(activeTimelineHelper().seq).toBe(3)
    now.setActiveHost('host_B')
    expect(activeTimelineHelper().seq).toBe(9)
  })

  it('disconnect surfaces in the slice and reconnect restores', async () => {
    const { sim } = await onlineHost('host_drop')
    sim.close(1006)
    await vi.advanceTimersByTimeAsync(0)
    expect(activeSlice({ ...useWorkbench.getState(), activeHostId: 'host_drop' })?.state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(100)
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(activeSlice({ ...useWorkbench.getState(), activeHostId: 'host_drop' })?.state).toBe('online')
  })

  it('turn.patch applies into the active slice; gap triggers re-open', async () => {
    const { conn, sim } = await onlineHost('host_p')
    useWorkbench.getState().setActiveHost('host_p')
    // The UI opens the session first — the timeline must exist before patches land.
    await openSessionInStore(conn, 'host_p', 'proj/shared-name.jsonl')
    await vi.advanceTimersByTimeAsync(1)
    // In-order patch applies.
    sim.push('turn.patch', { sessionKey: 'proj/shared-name.jsonl', patches: [{ op: 'session.state', seq: 8, state: { running: true } }] })
    const t = useWorkbench.getState().slices['host_p'].timelines['proj/shared-name.jsonl']
    expect(t?.seq).toBe(8)
    expect(t?.state.running).toBe(true)
    // Gap patch → timeline reset + re-open (seq back to snapshot value 7).
    sim.push('turn.patch', { sessionKey: 'proj/shared-name.jsonl', patches: [{ op: 'session.state', seq: 30, state: { running: false } }] })
    await vi.advanceTimersByTimeAsync(0)
    const after = useWorkbench.getState().slices['host_p'].timelines['proj/shared-name.jsonl']
    expect(after.seq).toBe(7) // fresh snapshot from re-open
  })

  it('reconnect replay containing timeline.reset requests a snapshot without blanking the current view', async () => {
    let openCount = 0
    let resolveSnapshot: (value: Record<string, unknown>) => void = () => {}
    const visibleTurn = runningTurn('visible across disconnect')
    const recoveredTurn = runningTurn('recovered after reset')
    const { conn, sim } = await onlineHost('host_replay_reset', {
      'session.open': (params) => {
        openCount += 1
        if (openCount === 1) return sessionOpenResult({ turns: [visibleTurn], state: { running: true } })
        if (openCount === 2) {
          expect(params).toMatchObject({ cursor: { epoch: 'e_1', seq: 7 } })
          return sessionOpenResult({ kind: 'replay', seq: 8, patches: [{ op: 'timeline.reset', seq: 8 }] })
        }
        return new Promise<Record<string, unknown>>((resolve) => { resolveSnapshot = resolve })
      },
    })
    useWorkbench.getState().setActiveHost('host_replay_reset')
    await openSessionInStore(conn, 'host_replay_reset', 'proj/shared-name.jsonl')

    sim.close(1006)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(openCount).toBe(3)
    expect(useWorkbench.getState().slices.host_replay_reset.timelines['proj/shared-name.jsonl'].turns[0].answer).toBe('visible across disconnect')

    resolveSnapshot(sessionOpenResult({ seq: 8, turns: [recoveredTurn], state: { running: true } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(useWorkbench.getState().slices.host_replay_reset.timelines['proj/shared-name.jsonl'].turns[0].answer).toBe('recovered after reset')
  })

  it('timeline.reset preserves the current view until one fresh snapshot resolves', async () => {
    let openCount = 0
    let resolveSnapshot: (value: Record<string, unknown>) => void = () => {}
    const firstTurn = runningTurn('currently visible')
    const bufferedTurn: Turn = { ...runningTurn('newer event survives resync'), id: 't-next', anchor: 'a-next' }
    const { conn, sim } = await onlineHost('host_timeline_reset', {
      'session.open': () => {
        openCount += 1
        if (openCount === 1) return sessionOpenResult({ turns: [firstTurn], state: { running: true } })
        return new Promise<Record<string, unknown>>((resolve) => { resolveSnapshot = resolve })
      },
    })
    useWorkbench.getState().setActiveHost('host_timeline_reset')
    await openSessionInStore(conn, 'host_timeline_reset', 'proj/shared-name.jsonl')
    expect(useWorkbench.getState().slices.host_timeline_reset.timelines['proj/shared-name.jsonl'].turns).toHaveLength(1)

    sim.push('turn.patch', { sessionKey: 'proj/shared-name.jsonl', patches: [{ op: 'timeline.reset', seq: 8 }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(openCount).toBe(2)
    expect(useWorkbench.getState().slices.host_timeline_reset.timelines['proj/shared-name.jsonl'].turns[0].answer).toBe('currently visible')

    // A patch arriving while the snapshot is in flight must be buffered, not lost or cause a duplicate open.
    sim.push('turn.patch', { sessionKey: 'proj/shared-name.jsonl', patches: [{ op: 'turn.upsert', seq: 9, turn: bufferedTurn }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(openCount).toBe(2)

    // Snapshot is seq 8 but the host already sent seq 9 during the RPC; the client must apply that patch after the snapshot.
    resolveSnapshot(sessionOpenResult({ seq: 8, turns: [firstTurn], state: { running: true } }))
    await vi.advanceTimersByTimeAsync(0)
    const restored = useWorkbench.getState().slices.host_timeline_reset.timelines['proj/shared-name.jsonl']
    expect(restored.seq).toBe(9)
    expect(restored.turns.map((turn) => turn.answer)).toEqual(['currently visible', 'newer event survives resync'])
  })

  it('patches racing an explicit session.open are buffered and applied after its snapshot', async () => {
    let openCount = 0
    let resolveSnapshot: (value: Record<string, unknown>) => void = () => {}
    const firstTurn = runningTurn('visible before reopen')
    const { conn, sim } = await onlineHost('host_open_buffer', {
      'session.open': () => {
        openCount += 1
        if (openCount === 1) return sessionOpenResult({ turns: [firstTurn], state: { running: true } })
        return new Promise<Record<string, unknown>>((resolve) => { resolveSnapshot = resolve })
      },
    })
    useWorkbench.getState().setActiveHost('host_open_buffer')
    await openSessionInStore(conn, 'host_open_buffer', 'proj/shared-name.jsonl')

    const reopening = openSessionInStore(conn, 'host_open_buffer', 'proj/shared-name.jsonl')
    await vi.advanceTimersByTimeAsync(0)
    sim.push('turn.patch', { sessionKey: 'proj/shared-name.jsonl', patches: [{ op: 'session.state', seq: 8, state: { running: false } }] })
    await vi.advanceTimersByTimeAsync(0)
    resolveSnapshot(sessionOpenResult({ seq: 7, turns: [firstTurn], state: { running: true } }))
    await reopening

    const restored = useWorkbench.getState().slices.host_open_buffer.timelines['proj/shared-name.jsonl']
    expect(restored.seq).toBe(8)
    expect(restored.state.running).toBe(false)
  })

  it('a failed snapshot resync keeps visible turns and a later patch retries', async () => {
    let openCount = 0
    const visibleTurn = runningTurn('still visible')
    const { conn, sim } = await onlineHost('host_resync_retry', {
      'session.open': () => {
        openCount += 1
        if (openCount === 1) return sessionOpenResult({ turns: [visibleTurn], state: { running: true } })
        if (openCount === 2) return Promise.reject(new Error('snapshot unavailable'))
        return sessionOpenResult({ seq: 9, turns: [runningTurn('recovered')], state: { running: true } })
      },
    })
    useWorkbench.getState().setActiveHost('host_resync_retry')
    await openSessionInStore(conn, 'host_resync_retry', 'proj/shared-name.jsonl')

    sim.push('turn.patch', { sessionKey: 'proj/shared-name.jsonl', patches: [{ op: 'timeline.reset', seq: 8 }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(openCount).toBe(2)
    expect(useWorkbench.getState().slices.host_resync_retry.timelines['proj/shared-name.jsonl'].turns[0].answer).toBe('still visible')

    sim.push('turn.patch', { sessionKey: 'proj/shared-name.jsonl', patches: [{ op: 'session.state', seq: 9, state: { running: true } }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(openCount).toBe(3)
    expect(useWorkbench.getState().slices.host_resync_retry.timelines['proj/shared-name.jsonl'].turns[0].answer).toBe('recovered')
  })

  it('closing a session cancels its pending resync and ignores late patches', async () => {
    let openCount = 0
    let resolveSnapshot: (value: Record<string, unknown>) => void = () => {}
    const visibleTurn = runningTurn('still visible after close')
    const { conn, sim } = await onlineHost('host_close_resync', {
      'session.open': () => {
        openCount += 1
        if (openCount === 1) return sessionOpenResult({ turns: [visibleTurn], state: { running: true } })
        return new Promise<Record<string, unknown>>((resolve) => { resolveSnapshot = resolve })
      },
      'session.close': () => ({}),
    })
    useWorkbench.getState().setActiveHost('host_close_resync')
    await openSessionInStore(conn, 'host_close_resync', 'proj/shared-name.jsonl')
    sim.push('turn.patch', { sessionKey: 'proj/shared-name.jsonl', patches: [{ op: 'timeline.reset', seq: 8 }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(openCount).toBe(2)

    await conn.closeSession('proj/shared-name.jsonl')
    sim.push('turn.patch', { sessionKey: 'proj/shared-name.jsonl', patches: [{ op: 'session.state', seq: 9, state: { running: false } }] })
    await vi.advanceTimersByTimeAsync(0)
    resolveSnapshot(sessionOpenResult({ seq: 9, turns: [runningTurn('must not reopen')], state: { running: false } }))
    await vi.advanceTimersByTimeAsync(0)

    expect(conn.watchList()).not.toContain('proj/shared-name.jsonl')
    expect(openCount).toBe(2)
    expect(useWorkbench.getState().slices.host_close_resync.timelines['proj/shared-name.jsonl'].turns[0].answer).toBe('still visible after close')
  })

  it('host.notice and ui.request flow into store (dialogs + notice banner)', async () => {
    const { conn, sim } = await onlineHost('host_ui')
    await openSessionInStore(conn, 'host_ui', 'proj/shared-name.jsonl')
    await vi.advanceTimersByTimeAsync(1)
    sim.push('ui.request', { id: 'u1', sessionKey: 'proj/shared-name.jsonl', method: 'confirm', title: 'Xoá?', message: 'Chắc không' })
    sim.push('host.notice', { level: 'warning', text: 'ProDesk LiX sắp restart' })
    await vi.advanceTimersByTimeAsync(1)
    const s = useWorkbench.getState()
    expect(s.slices['host_ui'].timelines['proj/shared-name.jsonl']?.pendingUi).toHaveLength(1)
    expect(s.notice).toMatchObject({ level: 'warning' })
    sim.push('ui.request', { id: 'u2', sessionKey: 'proj/shared-name.jsonl', method: 'notify', message: 'Đã lưu', notifyType: 'info' })
    expect(useWorkbench.getState().slices['host_ui'].timelines['proj/shared-name.jsonl']?.pendingUi).toHaveLength(1)
    expect(useWorkbench.getState().notice).toMatchObject({ level: 'info', text: 'Đã lưu' })
  })
})

import { activeTimeline } from './workbench-store'
function activeTimelineHelper() {
  return activeTimeline(useWorkbench.getState()) as { seq: number }
}
