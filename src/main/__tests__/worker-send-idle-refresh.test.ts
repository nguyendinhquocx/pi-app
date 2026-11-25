import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerSlot } from '../worker-manager-types'

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  runtime: { mode: 'host' as 'host' | 'wsl', distro: null as string | null },
}))
vi.mock('../config-store', () => ({ configStore: { get: vi.fn(() => undefined) } }))
vi.mock('../session-file-meta', () => ({
  readSessionMetaFromFile: vi.fn(async () => ({ cwd: '/workspace', sessionId: 'a' })),
  sessionFilePathForFs: (file: string) => file,
}))
vi.mock('../wsl/runtime-config', () => ({
  getAgentRuntimeConfig: () => mocks.runtime,
  isWslRuntimeActive: () => mocks.runtime.mode === 'wsl',
}))
vi.mock('../worker-pool-config', () => ({
  readMaxSessionWorkers: () => 4,
  readSessionWorkerIdleTimeoutMinutes: () => 15,
}))
vi.mock('../worker-manager-pool', async (original) => ({
  ...(await original<typeof import('../worker-manager-pool')>()),
  forkWorkerForCwd: mocks.fork,
}))

import { WorkerManager } from '../worker-manager'
import { attachWorkerHandlers } from '../worker-manager-pool'
import { normalizeSessionKey } from '../worker-session-key'

type Message = Record<string, unknown>
type Handler = (message: Message, reply: (response: Message) => void) => void
type Internals = { pool: Map<string, WorkerSlot>; foregroundPoolKey: string | null }

const key = (file: string) => normalizeSessionKey(file)

function makeSlot(file: string, handler: Handler): WorkerSlot {
  let listener: (message: Message) => void = () => {}
  const slot: WorkerSlot = {
    poolKey: key(file),
    cwd: '/workspace',
    sessionFile: key(file),
    runtime: { mode: 'host', distro: null },
    worker: {
      kind: 'utilityProcess',
      postMessage: vi.fn((message: Message) => handler(message, (response) => queueMicrotask(() => listener(response)))),
      onMessage: (cb) => {
        listener = cb as (message: Message) => void
      },
      onExit: vi.fn(),
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      kill: vi.fn(),
    },
    pendingRequests: new Map(),
    requestCounter: 0,
    initResolver: null,
    initRejecter: null,
    initPromise: null,
    agentTurnActive: false,
    lastIdleAt: Date.now(),
    lastForegroundAt: Date.now(),
    sdkFallback: false,
    autoRestartEnabled: true,
    stopping: false,
  }
  attachWorkerHandlers(slot, slot.worker, { mainWindow: null, onAppEvent: vi.fn(), onSlotExit: vi.fn() })
  return slot
}

function setup(slot: WorkerSlot) {
  const manager = new WorkerManager()
  const state = manager as unknown as Internals
  state.pool.set(slot.poolKey, slot)
  // Slot deliberately NOT foreground: Web/remote sends never set foreground.
  state.foregroundPoolKey = null
  return { manager, slot }
}

const normalReply: Handler = (message, reply) => {
  reply({ requestId: message.requestId, type: `${message.type}-done`, state: { sessionId: 'a' }, items: [] })
}

const FILE = 'C:/workspace/session-a.jsonl'

describe('turn-initiating RPC refreshes idle TTL for non-foreground (Web) sessions', () => {
  beforeEach(() => {
    mocks.fork.mockReset()
    mocks.runtime = { mode: 'host', distro: null }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it.each(['prompt', 'steer', 'followUp'] as const)('%s refreshes slot.lastIdleAt', async (method) => {
    const slot = makeSlot(FILE, normalReply)
    const before = slot.lastIdleAt
    const { manager } = setup(slot)
    vi.setSystemTime(new Date('2026-11-25T12:10:00Z'))

    if (method === 'prompt') await manager.sendPrompt('hi', FILE)
    else if (method === 'steer') await manager.steer('hi', FILE)
    else await manager.followUp('hi', FILE)

    expect(slot.lastIdleAt).toBe(Date.now())
    expect(slot.lastIdleAt).toBeGreaterThan(before)
  })

  it('non-turn RPC (getState) does not refresh slot.lastIdleAt', async () => {
    const slot = makeSlot(FILE, normalReply)
    const before = slot.lastIdleAt
    const { manager } = setup(slot)
    vi.setSystemTime(new Date('2026-11-25T12:10:00Z'))

    await manager.getState(FILE)

    expect(slot.lastIdleAt).toBe(before)
  })
})
