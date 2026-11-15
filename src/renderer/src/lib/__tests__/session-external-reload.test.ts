import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerTimelineScrollEl } from '@renderer/features/timeline/timeline-scroll-bridge'
import { TIMELINE_NEAR_BOTTOM_PX } from '@renderer/features/timeline/timeline-follow-scroll'
import { useUIStore } from '@renderer/stores/ui-store'
import type { TimelineItem } from '@renderer/stores/ui-store-types'
import { scheduleExternalSlimReload, slimReloadExternalUpdate } from '../session-timeline-sync'

/**
 * Slim reload of an externally updated session: merge by entry anchor, keep loaded pages,
 * keep the scroll anchor (real scroll-bridge element), never reload during a slot stream.
 */

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: invokeMock },
}))

function row(id: string, type: TimelineItem['type'], entry?: string, text = id): TimelineItem {
  return { id, type, text, timestamp: 0, ...(entry ? { sessionEntryId: entry } : {}) }
}

const FILE = 'C:/work/proj/.pi/sessions/ext.jsonl'

/** Loaded pages: e1..e40 (two pages of 20). */
const loadedPages = (): TimelineItem[] => Array.from({ length: 40 }, (_, i) => row(`l${i + 1}`, i % 2 === 0 ? 'user-message' : 'assistant-message', `e${i + 1}`))

/** Disk tail: last 20 rows, 5 newer entries appended (e41..e45). */
const diskTail = (): TimelineItem[] => [
  ...Array.from({ length: 15 }, (_, i) => row(`d${i + 26}`, i % 2 === 0 ? 'user-message' : 'assistant-message', `e${i + 26}`)),
  ...Array.from({ length: 5 }, (_, i) => row(`d${i + 41}`, i % 2 === 0 ? 'user-message' : 'assistant-message', `e${i + 41}`)),
]

function scrollEl(distanceFromBottom: number): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
  Object.defineProperty(el, 'scrollTop', { value: 2000 - 400 - distanceFromBottom, configurable: true, writable: true })
  return el
}

function visibleSession(): void {
  useUIStore.setState({
    historySessionFile: FILE,
    currentSessionId: 's1',
    timelineItems: loadedPages(),
    historyTotalCount: 40,
    historyLoadedCount: 40,
    historyLoading: false,
    streamingAssistantId: null,
    optimisticPendingUserText: null,
    agentTurnBootstrapping: false,
    sessionRuntimeRunning: {},
    workerLiveSnapshot: { sessionId: null, sessionFile: null, status: 'idle' },
  })
}

let anchorEvents: Array<{ reason: string } | undefined> = []
const onAnchor = (e: Event): void => {
  anchorEvents.push((e as CustomEvent<{ reason: string }>).detail)
}

beforeEach(() => {
  invokeMock.mockReset().mockImplementation(async (_method: string) => ({
    items: diskTail(),
    sourceCount: 20,
    totalCount: 45,
  }))
  anchorEvents = []
  window.addEventListener('pi-desktop:timeline-anchor', onAnchor)
  visibleSession()
})

afterEach(() => {
  window.removeEventListener('pi-desktop:timeline-anchor', onAnchor)
  registerTimelineScrollEl(null)
  useUIStore.setState({
    historySessionFile: null,
    timelineItems: [],
    sessionRuntimeRunning: {},
    sessionAttention: {},
    workerLiveSnapshot: { sessionId: null, sessionFile: null, status: 'idle' },
  })
})

describe('slimReloadExternalUpdate', () => {
  it('ignores a session that is not visible', async () => {
    const res = await slimReloadExternalUpdate('C:/work/other/.pi/sessions/x.jsonl')
    expect(res).toEqual({ applied: false, followed: false, reason: 'not-visible' })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does not reload while the slot worker snapshot says this session is streaming', async () => {
    useUIStore.setState({ workerLiveSnapshot: { sessionId: 's1', sessionFile: FILE, status: 'running' } })
    const res = await slimReloadExternalUpdate(FILE)
    expect(res).toEqual({ applied: false, followed: false, reason: 'local-turn-active' })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does reload while the external-running label is set (do not suppress the watcher that set it)', async () => {
    useUIStore.getState().setSessionRuntimeRunning(FILE, true)
    const res = await slimReloadExternalUpdate(FILE)
    expect(res.applied).toBe(true)
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('does not reload during a local turn (optimistic send / streaming)', async () => {
    useUIStore.setState({ optimisticPendingUserText: 'typing…' })
    const res = await slimReloadExternalUpdate(FILE)
    expect(res.reason).toBe('local-turn-active')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('merges the disk tail by anchor and KEEPS the loaded pages', async () => {
    registerTimelineScrollEl(scrollEl(600)) // mid-timeline: no follow
    const before = useUIStore.getState().timelineItems
    const res = await slimReloadExternalUpdate(FILE)
    expect(res.applied).toBe(true)

    const items = useUIStore.getState().timelineItems
    expect(items).toHaveLength(45)
    // The older page prefix is untouched (same objects, not re-fetched copies).
    expect(items.slice(0, 25).map((i) => i.id)).toEqual(before.slice(0, 25).map((i) => i.id))
    expect(items[0]).toBe(before[0])
    // New entries from disk are present.
    expect(items.at(-1)?.sessionEntryId).toBe('e45')
    expect(useUIStore.getState().historyTotalCount).toBe(45)
    expect(useUIStore.getState().historyLoadedCount).toBe(45)
  })

  it('keeps the scroll anchor mid-timeline (real scroll element, no follow request)', async () => {
    const el = scrollEl(600)
    registerTimelineScrollEl(el)
    const res = await slimReloadExternalUpdate(FILE)
    expect(res.applied).toBe(true)
    expect(res.followed).toBe(false)
    expect(el.scrollTop).toBe(1000) // untouched
    expect(anchorEvents).toHaveLength(0)
  })

  it('follows when reading near the bottom (through the real anchor event)', async () => {
    const el = scrollEl(TIMELINE_NEAR_BOTTOM_PX - 10)
    registerTimelineScrollEl(el)
    const res = await slimReloadExternalUpdate(FILE)
    expect(res.applied).toBe(true)
    expect(res.followed).toBe(true)
    expect(anchorEvents.map((e) => e?.reason)).toEqual(['resume-stream'])
  })

  it('ignores an empty tail (nothing to merge)', async () => {
    invokeMock.mockImplementation(async () => ({ items: [], sourceCount: 0, totalCount: 40 }))
    const res = await slimReloadExternalUpdate(FILE)
    expect(res).toEqual({ applied: false, followed: false })
  })
})

describe('scheduleExternalSlimReload debounce', () => {
  it('coalesces a burst into ONE reload 1.5s after the last event', async () => {
    vi.useFakeTimers()
    try {
      registerTimelineScrollEl(scrollEl(600))
      scheduleExternalSlimReload(FILE)
      scheduleExternalSlimReload(FILE)
      scheduleExternalSlimReload(FILE)
      await vi.advanceTimersByTimeAsync(1499)
      expect(invokeMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(invokeMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('running label via the runtime slice', () => {
  it('sets running from the payload and clears it on idle', () => {
    useUIStore.getState().setSessionRuntimeRunning(FILE, true)
    const state = useUIStore.getState()
    expect(Object.values(state.sessionRuntimeRunning).some((on) => on)).toBe(true)
    expect(state.sessionAttention[FILE.replace(/\\/g, '/')]).toBe('working')

    useUIStore.getState().setSessionRuntimeRunning(FILE, false)
    const after = useUIStore.getState()
    expect(Object.values(after.sessionRuntimeRunning).some((on) => on)).toBe(false)
    expect(Object.keys(after.sessionRuntimeRunning).length).toBe(0)
  })
})
