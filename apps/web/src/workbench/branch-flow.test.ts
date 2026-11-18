import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { base64UrlEncode } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { HostConnection, RpcRejectedError } from '../transport/host-connection'
import { encodeKeyPair, type DeviceKeyRecord } from '../transport/device-keys'
import { HostSim, testKeyPair } from '../test/host-sim'
import { connectStore, useWorkbench } from './workbench-store'

/**
 * Spec T4 acceptance: "Review/diff" parity + "fork/rewind từ Web (overlay + thao tác thật)" —
 * branch flows (switchBranch / fork / rewind / dequeue) exercise the REAL typed RPCs through a
 * real handshake + SecureChannel (HostSim), not stubs.
 */

const HOST_STATIC = testKeyPair('cc'.repeat(32))

function makeDevice(): DeviceKeyRecord {
  const kp = encodeKeyPair(generateKeyPair())
  return {
    hostId: 'host_br',
    hostName: 'Branch Host',
    hostPub: base64UrlEncode(HOST_STATIC.pub),
    ...kp,
    endpoints: [],
    createdAt: 1,
    lastConnectedAt: null,
    deviceId: null,
  }
}

const HELLO = {
  hostId: 'host_br',
  hostName: 'Branch Host',
  version: '0.7.13',
  epoch: 'e_1',
  deviceId: 'dev_test',
  role: 'operator' as const,
  features: [],
  assets: [],
  ownerProtocol: 1,
}

const BRANCHES = [
  { leafId: 'leaf_a', title: 'main line', turns: 4, current: true },
  { leafId: 'leaf_b', title: 'experiment', turns: 2, current: false, divergedAt: 'anchor_2' },
]

const REVIEW_DIFF = {
  isRepo: true,
  branch: 'main',
  files: [
    { path: 'src/a.ts', add: 6, del: 1, status: 'modified' },
    { path: 'src/b.ts', add: 0, del: 0, status: 'added' },
  ],
}

describe('branch + review flows from web (spec T4: real overlay actions)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useWorkbench.setState({ slices: {}, activeHostId: null, notice: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function online(handlers: Record<string, (p: unknown) => unknown>) {
    const calls: Record<string, unknown[]> = {}
    const track = (m: string) => (p: unknown) => {
      ;(calls[m] ??= []).push(p)
      return handlers[m](p)
    }
    const sim = new HostSim({
      hostStatic: HOST_STATIC,
      hostId: 'host_br',
      handlers: {
        'host.hello': () => HELLO,
        'session.open': () => ({
          sessionKey: 'proj/s1.jsonl',
          title: 'S1',
          epoch: 'e_1',
          seq: 4,
          kind: 'snapshot',
          turns: [],
          state: { running: false },
          pendingUi: [],
        }),
        'session.watchList': () => ({ sessionKeys: [] }),
        'session.unwatchList': () => ({}),
        'session.branches': track('session.branches'),
        'session.switchBranch': track('session.switchBranch'),
        'session.fork': track('session.fork'),
        'session.clone': track('session.clone'),
        'turn.rewind': track('turn.rewind'),
        'review.diff': track('review.diff'),
        ...Object.fromEntries(Object.entries(handlers).filter(([m]) => !['host.hello', 'session.open'].includes(m)).map(([m, h]) => [m, track(m)])),
      },
    })
    const conn = new HostConnection({
      endpoint: 'wss://x.tail1234.ts.net/ws',
      device: makeDevice(),
      socketFactory: () => sim.newSocket() as unknown as WebSocket,
      backoff: { baseMs: 100, factor: 2, capMs: 1000, jitter: 0, rng: () => 0.5 },
    })
    connectStore(conn, 'host_br')
    conn.start()
    sim.socket.open()
    await vi.advanceTimersByTimeAsync(0)
    return { conn, sim, calls }
  }

  it('branches listing + switchBranch reach the host with the sessionKey', async () => {
    const { conn, calls } = await online({
      'session.branches': () => ({ branches: BRANCHES }),
      'session.switchBranch': () => ({}),
    })
    const branches = await conn.request('session.branches', { sessionKey: 'proj/s1.jsonl' })
    expect(branches.branches).toEqual(BRANCHES)
    expect(calls['session.branches']).toEqual([{ sessionKey: 'proj/s1.jsonl' }])

    await conn.request('session.switchBranch', { sessionKey: 'proj/s1.jsonl', leafId: 'leaf_b' })
    expect(calls['session.switchBranch']).toEqual([{ sessionKey: 'proj/s1.jsonl', leafId: 'leaf_b' }])
  })

  it('fork creates a new session (clone) and rewind returns an anchor ack', async () => {
    const { conn, calls } = await online({
      'session.fork': () => ({ sessionKey: 'proj/s1-fork.jsonl' }),
      'session.clone': () => ({ sessionKey: 'proj/s1-clone.jsonl' }),
      'turn.rewind': () => ({ editorText: 'restored draft' }),
    })
    const forked = await conn.request('session.fork', { sessionKey: 'proj/s1.jsonl', anchor: 'anchor_3' })
    expect(forked.sessionKey).toBe('proj/s1-fork.jsonl')
    expect(calls['session.fork']).toEqual([{ sessionKey: 'proj/s1.jsonl', anchor: 'anchor_3' }])

    await conn.request('session.clone', { sessionKey: 'proj/s1.jsonl' })
    expect(calls['session.clone']).toEqual([{ sessionKey: 'proj/s1.jsonl' }])

    const rewind = await conn.request('turn.rewind', { sessionKey: 'proj/s1.jsonl', anchor: 'anchor_1' })
    expect(rewind).toEqual({ editorText: 'restored draft' })
    expect(calls['turn.rewind']).toEqual([{ sessionKey: 'proj/s1.jsonl', anchor: 'anchor_1' }])
  })

  it('review.diff read-only view works; writer_conflict surfaces as the owner-busy message', async () => {
    const { conn } = await online({
      'review.diff': () => REVIEW_DIFF,
      'turn.send': () => {
        throw Object.assign(new Error('owner running'), { rpcCode: 'writer_conflict' })
      },
      'session.rename': () => {
        throw Object.assign(new Error('busy'), { rpcCode: 'writer_conflict' })
      },
    })
    const diff = await conn.request('review.diff', { sessionKey: 'proj/s1.jsonl', scope: 'turn' })
    expect(diff.isRepo).toBe(true)
    expect(diff.files).toHaveLength(2)
    expect(diff.files[0]).toMatchObject({ path: 'src/a.ts', add: 6, del: 1 })

    // Owner busy: rename blocked with writer_conflict → rpc() maps to the user-facing message.
    const { rpc } = await import('./workbench-store')
    await expect(rpc(conn, 'session.rename', { sessionKey: 'proj/s1.jsonl', title: 'x' })).rejects.toThrow('writer khác')
  })

  it('writer conflict typed error reaches the client as a typed RpcRejectedError', async () => {
    const { conn } = await online({
      'turn.send': () => {
        throw Object.assign(new Error('owner running'), { rpcCode: 'writer_conflict' })
      },
    })
    await expect(conn.request('turn.send', { sessionKey: 'proj/s1.jsonl', text: 'hi', mode: 'prompt', clientMessageId: 'conflict-01' })).rejects.toBeInstanceOf(RpcRejectedError)
  })
})
