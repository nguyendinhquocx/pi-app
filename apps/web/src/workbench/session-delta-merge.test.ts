import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/remote'
import { useWorkbench } from './workbench-store'

const HOST = 'host_f2'

function row(sessionKey: string, updatedAt: number, title = sessionKey): SessionSummary {
  return { sessionKey, projectId: '/work/pi-app', title, status: 'idle', updatedAt }
}

/** Seed the slice the way `session.watchList` does: full snapshot, newest first. */
function seedSnapshot(n: number): SessionSummary[] {
  return Array.from({ length: n }, (_, i) => row(`session-${String(i).padStart(2, '0')}`, 1_000 - i))
}

describe('F2 sessions.update delta merge (workbench-store)', () => {
  beforeEach(() => {
    useWorkbench.setState({ slices: {}, activeHostId: HOST, notice: null })
    useWorkbench.getState().ensureSlice(HOST)
  })

  it('one-row delta merges into the existing rail instead of replacing it', () => {
    useWorkbench.getState().setSessions(HOST, seedSnapshot(25))
    expect(useWorkbench.getState().slices[HOST].sessions).toHaveLength(25)

    // Host flushes ONE dirty row (a title touch on session-07).
    const dirty = { ...row('session-07', 2_000, 'đã đổi tên') }
    useWorkbench.getState().mergeSessionDeltas(HOST, [dirty])

    const sessions = useWorkbench.getState().slices[HOST].sessions
    expect(sessions).toHaveLength(25)
    const updated = sessions.find((s) => s.sessionKey === 'session-07')
    expect(updated?.title).toBe('đã đổi tên')
    expect(updated?.updatedAt).toBe(2_000)
    // Untouched rows survive.
    expect(sessions.find((s) => s.sessionKey === 'session-00')?.updatedAt).toBe(1_000)
    expect(sessions.find((s) => s.sessionKey === 'session-24')?.updatedAt).toBe(976)
    // Newest-first ordering after merge.
    expect(sessions[0]?.sessionKey).toBe('session-07')
  })

  it('removal-only delta drops removed keys and keeps every other row', () => {
    useWorkbench.getState().setSessions(HOST, seedSnapshot(25))
    useWorkbench.getState().setTimeline(HOST, 'session-03', { events: [], seq: 1 } as never)
    useWorkbench.getState().selectSession(HOST, 'session-05')
    useWorkbench.getState().setTimeline(HOST, 'session-05', { events: [], seq: 1 } as never)

    useWorkbench.getState().mergeSessionDeltas(HOST, [], ['session-03', 'session-11'])

    const slice = useWorkbench.getState().slices[HOST]
    expect(slice.sessions).toHaveLength(23)
    expect(slice.sessions.some((s) => s.sessionKey === 'session-03')).toBe(false)
    expect(slice.sessions.some((s) => s.sessionKey === 'session-11')).toBe(false)
    expect(slice.sessions.some((s) => s.sessionKey === 'session-24')).toBe(true)
    // Removed non-selected timeline is cleaned; the selected session's timeline is kept.
    expect(slice.timelines['session-03']).toBeUndefined()
    expect(slice.timelines['session-05']).toBeDefined()
  })

  it('delta for an unknown row upserts it (new session created remotely)', () => {
    useWorkbench.getState().setSessions(HOST, seedSnapshot(3))
    useWorkbench.getState().mergeSessionDeltas(HOST, [row('session-new', 3_000)])

    const sessions = useWorkbench.getState().slices[HOST].sessions
    expect(sessions).toHaveLength(4)
    expect(sessions[0]?.sessionKey).toBe('session-new')
  })

  it('full snapshot via setSessions still replaces the whole list (watchList path unchanged)', () => {
    useWorkbench.getState().setSessions(HOST, seedSnapshot(25))
    useWorkbench.getState().mergeSessionDeltas(HOST, [row('session-07', 2_000)])
    expect(useWorkbench.getState().slices[HOST].sessions).toHaveLength(25)

    // Reconnect/refresh returns a fresh snapshot: total replacement is correct here.
    useWorkbench.getState().setSessions(HOST, seedSnapshot(5))
    expect(useWorkbench.getState().slices[HOST].sessions).toHaveLength(5)
  })
})
