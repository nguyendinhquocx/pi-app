import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { base64UrlEncode } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { HostConnection } from '../transport/host-connection'
import { encodeKeyPair, type DeviceKeyRecord } from '../transport/device-keys'
import { HostSim, testKeyPair } from '../test/host-sim'
import { connectStore, openSessionInStore, useWorkbench } from './workbench-store'
import { agentRunsFromTurns } from './agent-runs'
import { AgentsPanel } from './AgentsPanel'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Spec T4 acceptance: spawn → run visible in Agents view → progress/result → steer/abort/resume
 * with no stale context. T2 SessionSummary intentionally lacks child→parent IDs, so this Agents
 * view is grounded in the parent's actual subagent-tab tool step; deep navigation into child
 * JSONL files is explicitly excluded in the parity matrix (remote gap #9).
 *
 * All actions below use a real Noise-IK handshake + SecureChannel through HostSim. This proves
 * the actual RPC/event path, not a mocked session timeline.
 */

const HOST_STATIC = testKeyPair('dd'.repeat(32))

function makeDevice(): DeviceKeyRecord {
  const kp = encodeKeyPair(generateKeyPair())
  return {
    hostId: 'host_sub',
    hostName: 'Sub Host',
    hostPub: base64UrlEncode(HOST_STATIC.pub),
    ...kp,
    endpoints: [],
    createdAt: 1,
    lastConnectedAt: null,
    deviceId: null,
  }
}

const HELLO = {
  hostId: 'host_sub',
  hostName: 'Sub Host',
  version: '0.7.13',
  epoch: 'e_1',
  deviceId: 'dev_test',
  role: 'operator' as const,
  features: [],
  assets: [],
  ownerProtocol: 1,
}

const parentSummary = {
  sessionKey: 'proj/parent.jsonl',
  projectId: 'p1',
  title: 'Parent session',
  status: 'running' as const,
  updatedAt: 10,
}

function snapshot(seq: number): Record<string, unknown> {
  return {
    sessionKey: 'proj/parent.jsonl',
    title: 'Parent session',
    epoch: 'e_1',
    seq,
    kind: 'snapshot',
    turns: [],
    state: { running: false },
    pendingUi: [],
  }
}

describe('subagent-tab Agents view flow (spec T4 acceptance)', () => {
  let activeConnection: HostConnection | null = null
  beforeEach(() => {
    activeConnection = null
    useWorkbench.setState({ slices: {}, activeHostId: null, notice: null })
  })

  afterEach(() => {
    cleanup()
    activeConnection?.stop()
    activeConnection = null
  })

  it('spawn → visible run/progress → steer/abort → result → resume, preserving parent session context', async () => {
    const calls: Record<string, unknown[]> = {}
    let spawnCount = 0
    const sim = new HostSim({
      hostStatic: HOST_STATIC,
      hostId: 'host_sub',
      handlers: {
        'host.hello': () => HELLO,
        'session.open': () => snapshot(4),
        'session.watchList': () => ({ sessions: [parentSummary] }),
        'session.unwatchList': () => ({}),
        'turn.send': (raw) => {
          const params = raw as { mode: string; text: string }
          calls.send ??= []
          calls.send.push(params)
          if (spawnCount++ === 0) {
            sim.push('sessions.update', { sessions: [parentSummary] })
            sim.push('turn.patch', {
              sessionKey: 'proj/parent.jsonl',
              patches: [
                {
                  op: 'turn.upsert',
                  seq: 5,
                  turn: {
                    id: 'turn_parent',
                    anchor: 'anchor_parent',
                    status: 'running',
                    user: { text: 'Ask subagent-tab to implement the parser' },
                    activity: { counts: { read: 0, edit: 0, write: 0, run: 0, search: 0, think: 0, other: 0 }, failed: 0 },
                    steps: [],
                    answer: '',
                    files: [],
                  },
                },
                {
                  op: 'step.upsert',
                  seq: 6,
                  turnId: 'turn_parent',
                  step: {
                    id: 'step_subagent',
                    kind: 'tool',
                    toolCallId: 'call_subagent',
                    toolName: 'subagent_tab',
                    category: 'other',
                    status: 'running',
                    node: { template: 'tree', title: 'Implement parser', fields: {}, status: 'running', preview: 'Đang đọc source…', detail: true, fallbackText: 'subagent running' },
                  },
                  counts: { read: 0, edit: 0, write: 0, run: 0, search: 0, think: 0, other: 1 },
                  failed: 0,
                },
              ],
            })
          }
          return { accepted: true }
        },
        'turn.abort': () => {
          calls.abort = [{}]
          sim.push('turn.patch', {
            sessionKey: 'proj/parent.jsonl',
            patches: [{
              op: 'step.upsert',
              seq: 7,
              turnId: 'turn_parent',
              step: {
                id: 'step_subagent',
                kind: 'tool',
                toolCallId: 'call_subagent',
                toolName: 'subagent_tab',
                category: 'other',
                status: 'ok',
                node: { template: 'tree', title: 'Implement parser', fields: {}, status: 'ok', preview: 'Parser implemented; 4 files changed.', detail: true, fallbackText: 'subagent completed' },
              },
              counts: { read: 4, edit: 2, write: 0, run: 1, search: 0, think: 0, other: 1 },
              failed: 0,
            }],
          })
          return { aborted: true, wasRunning: true, stopped: true, restored: [] }
        },
        'turn.toolDetail': () => ({ node: { template: 'tree', title: 'Implement parser', fields: {}, status: 'ok', fallbackText: 'done' }, output: 'Parser implemented; 4 files changed.' }),
      },
    })

    const conn = new HostConnection({
      endpoint: 'wss://x.tail1234.ts.net/ws',
      device: makeDevice(),
      socketFactory: () => sim.newSocket() as unknown as WebSocket,
      backoff: { baseMs: 100, factor: 2, capMs: 1000, jitter: 0, rng: () => 0.5 },
    })
    activeConnection = conn
    connectStore(conn, 'host_sub')
    conn.start()
    sim.socket.open()
    useWorkbench.getState().setActiveHost('host_sub')
    useWorkbench.getState().selectSession('host_sub', 'proj/parent.jsonl')
    await openSessionInStore(conn, 'host_sub', 'proj/parent.jsonl')

    // Spawn a subagent from the parent session. The live tool step is the canonical Agents row.
    await conn.request('turn.send', {
      sessionKey: 'proj/parent.jsonl',
      text: 'spawn a subagent-tab child to implement the parser',
      mode: 'prompt',
      clientMessageId: 'spawn-0001',
    })

    const parentTimeline = useWorkbench.getState().slices.host_sub.timelines['proj/parent.jsonl']
    let runs = agentRunsFromTurns(parentTimeline.turns, 'proj/parent.jsonl')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'running', title: 'Implement parser', progress: 'Đang đọc source…' })

    const onSteer = vi.fn(async (text: string) => {
      await conn.request('turn.send', { sessionKey: 'proj/parent.jsonl', text, mode: 'steer', clientMessageId: 'steer-00001' })
    })
    const onAbort = vi.fn(async () => {
      await conn.request('turn.abort', { sessionKey: 'proj/parent.jsonl' })
    })
    const onResume = vi.fn(async (text: string) => {
      await conn.request('turn.send', { sessionKey: 'proj/parent.jsonl', text, mode: 'followUp', clientMessageId: 'resume-0001' })
    })
    render(
      <AgentsPanel
        runs={runs}
        onLoadDetail={async (id) => {
          const result = await conn.request('turn.toolDetail', { sessionKey: 'proj/parent.jsonl', toolCallId: id })
          return result.output ?? ''
        }}
        onSteer={onSteer}
        onAbort={onAbort}
        onResume={onResume}
      />,
    )

    expect(screen.getByText('Implement parser')).toBeTruthy()
    expect(screen.getByText('Đang đọc source…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Xem kết quả' }))
    await waitFor(() => expect(screen.getByText('Parser implemented; 4 files changed.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
    fireEvent.change(screen.getByLabelText('Steer agent'), { target: { value: 'Add one regression test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gửi steer' }))
    await waitFor(() => expect(onSteer).toHaveBeenCalledWith('Add one regression test'))

    fireEvent.click(screen.getByRole('button', { name: 'Abort lượt cha' }))
    await waitFor(() => expect(onAbort).toHaveBeenCalled())
    runs = agentRunsFromTurns(useWorkbench.getState().slices.host_sub.timelines['proj/parent.jsonl'].turns, 'proj/parent.jsonl')
    expect(runs[0].status).toBe('completed')

    // The parent session remains selected; resume uses the visible child result, not a stale
    // child context loaded elsewhere.
    expect(useWorkbench.getState().slices.host_sub.selectedSessionKey).toBe('proj/parent.jsonl')
    await onResume(`Continue from ${runs[0].preview}`)
    expect(onResume).toHaveBeenCalledWith('Continue from Parser implemented; 4 files changed.')
    expect(calls.send.map((p) => (p as { mode: string }).mode)).toEqual(['prompt', 'steer', 'followUp'])
    expect(calls.abort).toHaveLength(1)
  })
})
