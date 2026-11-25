import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { base64UrlEncode } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { HostConnection, DisconnectedError, type ConnState } from './host-connection'
import { encodeKeyPair, type DeviceKeyRecord } from './device-keys'
import { HostSim, testKeyPair } from '../test/host-sim'

const HOST_STATIC = testKeyPair('aa'.repeat(32))

function makeDevice(hostId = 'host_w'): DeviceKeyRecord {
  const kp = encodeKeyPair(generateKeyPair())
  return {
    hostId,
    hostName: 'Web Test Host',
    hostPub: base64UrlEncode(HOST_STATIC.pub),
    ...kp,
    endpoints: ['wss://w.tail1234.ts.net/ws'],
    createdAt: 1,
    lastConnectedAt: null,
    deviceId: null,
  }
}

const HELLO = {
  hostId: 'host_w',
  hostName: 'Web Test Host',
  version: '0.7.13',
  epoch: 'e_1',
  deviceId: 'dev_test',
  role: 'operator' as const,
  features: [],
  assets: [],
  ownerProtocol: 1,
}

function sessionOpenResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionKey: 'proj/s1.jsonl',
    title: 'S1',
    epoch: 'e_1',
    seq: 7,
    kind: 'snapshot',
    turns: [],
    state: { running: false },
    pendingUi: [],
    ...overrides,
  }
}

describe('HostConnection (spec T3)', () => {
  let device: DeviceKeyRecord

  beforeEach(() => {
    vi.useFakeTimers()
    device = makeDevice()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Connect through a fresh sim and drive until online. */
  async function onlineConn(
    handlers: Record<string, (p: unknown) => unknown> = {},
    events: ConstructorParameters<typeof HostConnection>[0]['events'] = {},
    deviceOverride?: DeviceKeyRecord,
  ): Promise<{ conn: HostConnection; sim: HostSim }> {
    const sim = new HostSim({
      hostStatic: HOST_STATIC,
      hostId: 'host_w',
      handlers: { 'host.hello': () => HELLO, ...handlers },
    })
    const conn = new HostConnection({
      endpoint: 'wss://w.tail1234.ts.net/ws',
      device: deviceOverride ?? device,
      socketFactory: () => sim.newSocket() as unknown as WebSocket,
      backoff: { baseMs: 500, factor: 2, capMs: 8000, jitter: 0, rng: () => 0.5 },
      pingIntervalMs: 30_000,
      events,
    })
    conn.start()
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    return { conn, sim }
  }

  it('handshake → online → hello carries host identity + ownerProtocol', async () => {
    const states: ConnState[] = []
    const { conn } = await onlineConn({}, { onState: (s) => states.push(s) })
    expect(conn.online).toBe(true)
    expect(conn.state).toBe('online')
    expect(conn.hello).toMatchObject({ hostId: 'host_w', epoch: 'e_1', ownerProtocol: 1 })
    expect(states).toContain('handshaking')
    expect(states).toContain('online')
  })

  it('wrong device key → hs_err → never online, state reconnecting', async () => {
    const wrongDevice = { ...device, hostPub: base64UrlEncode(generateKeyPair().pub) }
    const { conn } = await onlineConn({}, {}, wrongDevice)
    expect(conn.online).toBe(false)
    expect(conn.state).toBe('reconnecting')
    expect(conn.errorDetail).toContain('handshake')
  })

  it('pins host identity in addition to the crypto static key (wrong hostId is refused)', async () => {
    const sim = new HostSim({ hostStatic: HOST_STATIC, hostId: 'host_other', handlers: { 'host.hello': () => HELLO } })
    const conn = new HostConnection({
      endpoint: 'wss://w.tail1234.ts.net/ws',
      device,
      socketFactory: () => sim.newSocket() as unknown as WebSocket,
      backoff: { baseMs: 500, factor: 2, capMs: 8000, jitter: 0, rng: () => 0.5 },
    })
    conn.start()
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(conn.online).toBe(false)
    expect(conn.errorDetail).toContain('host identity mismatch')
  })

  it('sends the pair token for first hs1 only, then drops it after a successful handshake', async () => {
    const sim = new HostSim({ hostStatic: HOST_STATIC, hostId: 'host_w', handlers: { 'host.hello': () => HELLO } })
    const conn = new HostConnection({
      endpoint: 'wss://w.tail1234.ts.net/ws',
      device,
      pairToken: 'pair-token-one-time',
      socketFactory: () => sim.newSocket() as unknown as WebSocket,
      backoff: { baseMs: 500, factor: 2, capMs: 8000, jitter: 0, rng: () => 0.5 },
    })
    conn.start()
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(sim.pairTokens[0]).toBe('pair-token-one-time')
    sim.close(1006)
    await vi.advanceTimersByTimeAsync(500)
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(sim.pairTokens[1]).toBeUndefined()
    conn.stop()
  })

  it('typed RPC resolves with the schema-parsed result', async () => {
    const { conn } = await onlineConn({
      'session.stats': () => ({ context: { tokens: 10, messages: 2, breakdown: [] }, usage: null }),
    })
    const stats = await conn.request('session.stats', { sessionKey: 'proj/s1.jsonl' })
    expect(stats.context?.tokens).toBe(10)
  })

  it('server rejects → typed error surfaces as RpcRejectedError', async () => {
    const { conn } = await onlineConn({})
    await expect(conn.request('session.stats', { sessionKey: 'x.jsonl' })).rejects.toMatchObject({
      rpcError: { code: 'not_supported' },
    })
  })

  it('requests while offline reject immediately — nothing queued (no ambiguous delivery)', async () => {
    const sim = new HostSim({ hostStatic: HOST_STATIC, hostId: 'host_w', handlers: { 'host.hello': () => HELLO } })
    const conn = new HostConnection({
      endpoint: 'wss://w.tail1234.ts.net/ws',
      device,
      socketFactory: () => sim.newSocket() as unknown as WebSocket,
    })
    conn.start()
    await expect(
      conn.request('turn.send', { sessionKey: 's.jsonl', text: 'hi', mode: 'prompt', clientMessageId: 'm1' }),
    ).rejects.toBeInstanceOf(DisconnectedError)
  })

  it('allows a cold turn.send worker-init window without extending ordinary RPC deadlines', async () => {
    const { conn } = await onlineConn({
      'session.stats': () => new Promise<never>(() => {}),
      'turn.send': () => new Promise<never>(() => {}),
    })
    const ordinary = conn.request('session.stats', { sessionKey: 'proj/s1.jsonl' }).then(() => null, (error: Error) => error)
    const send = conn.request('turn.send', {
      sessionKey: 'proj/s1.jsonl', text: 'hi', mode: 'prompt', clientMessageId: 'cold-start-send-1',
    }).then(() => null, (error: Error) => error)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(await ordinary).toMatchObject({ message: 'session.stats timed out' })
    expect(await Promise.race([send, Promise.resolve('still-pending')])).toBe('still-pending')

    await vi.advanceTimersByTimeAsync(69_999)
    expect(await Promise.race([send, Promise.resolve('still-pending')])).toBe('still-pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(await send).toMatchObject({ message: 'turn.send timed out' })
    conn.stop()
  })

  it('gives session.create its own 90s window (busy laptop hosts exceed 20s — owner UAT R4)', async () => {
    const { conn } = await onlineConn({
      'session.stats': () => new Promise<never>(() => {}),
      'session.create': () => new Promise<never>(() => {}),
    })
    const ordinary = conn.request('session.stats', { sessionKey: 'proj/s1.jsonl' }).then(() => null, (error: Error) => error)
    const create = conn.request('session.create', { projectId: 'p1' }).then(() => null, (error: Error) => error)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(await ordinary).toMatchObject({ message: 'session.stats timed out' })
    expect(await Promise.race([create, Promise.resolve('still-pending')])).toBe('still-pending')

    await vi.advanceTimersByTimeAsync(69_999)
    expect(await Promise.race([create, Promise.resolve('still-pending')])).toBe('still-pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(await create).toMatchObject({ message: 'session.create timed out' })
    conn.stop()
  })

  it('pending request fails on socket drop; reconnect resumes watched sessions from the cursor', async () => {
    const opens: unknown[] = []
    const { conn, sim } = await onlineConn({
      'session.open': (p) => {
        opens.push(p)
        const params = p as { cursor?: { epoch: string; seq: number } }
        if (params.cursor) return sessionOpenResult({ kind: 'replay', patches: [], turns: [] })
        return sessionOpenResult()
      },
      'session.stats': () => new Promise<never>(() => {}), // request in flight, no answer
    })
    const open = await conn.openSession('proj/s1.jsonl')
    expect(open.kind).toBe('snapshot')

    sim.push('turn.patch', {
      sessionKey: 'proj/s1.jsonl',
      patches: [{ op: 'session.state', seq: 8, state: { running: true } }],
    })

    const slowExpect = expect(conn.request('session.stats', { sessionKey: 'proj/s1.jsonl' })).rejects.toBeInstanceOf(
      DisconnectedError,
    )
    // Let the request reach the (non-responding) handler first, then drop the socket.
    await vi.advanceTimersByTimeAsync(0)
    sim.close(1006)
    await slowExpect

    opens.length = 0
    await vi.advanceTimersByTimeAsync(500)
    // The reconnect timer fired; its factory created a fresh socket — open it.
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(conn.online).toBe(true)
    expect(opens).toEqual([{ sessionKey: 'proj/s1.jsonl', cursor: { epoch: 'e_1', seq: 8 } }])
  })

  it('late session.open cannot overwrite a newer snapshot or roll back the reconnect cursor', async () => {
    let resolveOld: (value: Record<string, unknown>) => void = () => {}
    const paramsSeen: unknown[] = []
    const applied: number[] = []
    const { conn, sim } = await onlineConn(
      {
        'session.open': (params) => {
          paramsSeen.push(params)
          if (paramsSeen.length === 1) return new Promise<Record<string, unknown>>((resolve) => { resolveOld = resolve })
          if (paramsSeen.length === 2) return sessionOpenResult({ seq: 9 })
          return sessionOpenResult({ kind: 'replay', seq: 10, patches: [] })
        },
      },
      { onSessionOpen: (_key, result) => applied.push(result.seq) },
    )

    const staleOpen = conn.openSession('proj/s1.jsonl')
    await vi.advanceTimersByTimeAsync(0)
    const latestOpen = await conn.openSession('proj/s1.jsonl')
    await vi.advanceTimersByTimeAsync(0)
    expect(latestOpen.seq).toBe(9)

    sim.push('turn.patch', { sessionKey: 'proj/s1.jsonl', patches: [{ op: 'session.state', seq: 10, state: { running: true } }] })
    await vi.advanceTimersByTimeAsync(0)
    resolveOld(sessionOpenResult({ seq: 8 }))
    await staleOpen
    expect(applied).toEqual([9])

    sim.close(1006)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(paramsSeen[2]).toEqual({ sessionKey: 'proj/s1.jsonl', cursor: { epoch: 'e_1', seq: 10 } })
    expect(applied).toEqual([9, 10])
  })

  it('epoch_changed forces the snapshot resync path (cursor/epoch contract)', async () => {
    const resyncs: { sessionKey: string; reason: string }[] = []
    const { conn } = await onlineConn(
      {
        'session.open': (p) => {
          const params = p as { cursor?: unknown }
          if (params.cursor) return sessionOpenResult({ epoch: 'e_2', seq: 3, resync: 'epoch_changed', turns: [] })
          return sessionOpenResult()
        },
      },
      { onResync: (s, r) => resyncs.push({ sessionKey: s, reason: r }) },
    )
    const open = await conn.openSession('proj/s1.jsonl', { epoch: 'e_OLD', seq: 1 })
    expect(open.resync).toBe('epoch_changed')
    expect(open.epoch).toBe('e_2')
    expect(resyncs).toEqual([{ sessionKey: 'proj/s1.jsonl', reason: 'epoch_changed' }])
  })

  it('terminal PTY open/input/resize/close and terminal.data/exit events use the typed wire contract', async () => {
    const outputs: string[] = []
    const { conn, sim } = await onlineConn({
      'terminal.open': () => ({ terminalId: 'term_1', profile: 'bash' }),
      'terminal.input': () => ({}),
      'terminal.resize': () => ({}),
      'terminal.close': () => ({}),
    })
    const unsubscribe = conn.subscribeEvents((event, payload) => {
      if (event === 'terminal.data') outputs.push((payload as { terminalId: string; data: string }).data)
      if (event === 'terminal.exit') outputs.push(`exit:${(payload as { code?: number }).code}`)
    })
    const opened = await conn.request('terminal.open', { sessionKey: 'proj/s1.jsonl', cols: 80, rows: 24 })
    expect(opened.terminalId).toBe('term_1')
    sim.push('terminal.data', { terminalId: 'term_1', data: 'hello\\r\\n' })
    sim.push('terminal.exit', { terminalId: 'term_1', code: 0 })
    expect(outputs).toEqual(['hello\\r\\n', 'exit:0'])
    await conn.request('terminal.input', { terminalId: 'term_1', data: 'pwd\\r' })
    await conn.request('terminal.resize', { terminalId: 'term_1', cols: 100, rows: 30 })
    await conn.request('terminal.close', { terminalId: 'term_1' })
    unsubscribe()
  })

  it('unknown custom ui.request is forwarded for the Web fallback card instead of silently dropped', async () => {
    const received: unknown[] = []
    const { sim } = await onlineConn({}, { onEvent: (event, payload) => { if (event === 'ui.request') received.push(payload) } })
    sim.push('ui.request', {
      id: 'u_custom',
      sessionKey: 'proj/s1.jsonl',
      method: 'custom',
      kind: 'vendor_custom_panel',
      extensionName: 'vendor-extension',
      toolName: 'custom_tool',
      token: 'not-for-logs',
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'unknown_custom', rawKind: 'vendor_custom_panel', extensionName: 'vendor-extension', toolName: 'custom_tool' })
  })

  it('keepalive ping fires every pingInterval and the host answers pong', async () => {
    const { sim } = await onlineConn({})
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sim.pingCount).toBeGreaterThanOrEqual(2)
  })

  it('stop() closes for good: no reconnect, state closed', async () => {
    const { conn, sim } = await onlineConn({})
    conn.stop()
    expect(conn.state).toBe('closed')
    expect(sim.socket.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(conn.state).toBe('closed')
  })

  it('not_found on resume drops the session from the watch set but stays online', async () => {
    let first = true
    const { conn, sim } = await onlineConn({
      'session.open': (p) => {
        const params = p as { cursor?: unknown }
        if (!params.cursor && first) {
          first = false
          return sessionOpenResult({ sessionKey: 'proj/gone.jsonl' })
        }
        throw Object.assign(new Error('gone'), { rpcCode: 'not_found' })
      },
    })
    await conn.openSession('proj/gone.jsonl')
    expect(conn.watchList()).toEqual(['proj/gone.jsonl'])

    sim.close(1006)
    await vi.advanceTimersByTimeAsync(500)
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(conn.online).toBe(true)
    expect(conn.watchList()).toEqual([])
  })
})
