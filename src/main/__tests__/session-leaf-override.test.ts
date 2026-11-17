import { beforeEach, describe, expect, it } from 'vitest'
import type { AppEvent } from '@shared/app-events'
import {
  applySessionEventToSessionLeafOverride,
  clearSessionLeafOverride,
  getSessionLeafOverride,
  noteSessionOwnerEpoch,
  setSessionLeafOverride,
} from '../session-leaf-override'

describe('session leaf override lifecycle', () => {
  beforeEach(() => {
    clearSessionLeafOverride()
  })

  it('should_clear_rewind_override_after_matching_session_settles', () => {
    const sessionFile = '/workspace/session-a.jsonl'
    setSessionLeafOverride(sessionFile, 'rewound-leaf')

    applySessionEventToSessionLeafOverride({
      type: 'run',
      phase: 'idle',
      settled: true,
      sessionFile,
      seq: 1,
      workspaceId: '/workspace',
      timestamp: 1,
    } as AppEvent)

    expect(getSessionLeafOverride(sessionFile)).toBeUndefined()
  })

  it('clears the old rewind once the new user message is persisted', () => {
    const sessionFile = '/workspace/session-a.jsonl'
    setSessionLeafOverride(sessionFile, 'rewound-leaf')
    setSessionLeafOverride('/workspace/session-b.jsonl', 'other-leaf')

    applySessionEventToSessionLeafOverride({
      type: 'message', role: 'user', phase: 'end', sessionFile,
      sessionEntryId: 'new-prompt', seq: 1, workspaceId: '/workspace', timestamp: 1,
    } as AppEvent)

    expect(getSessionLeafOverride(sessionFile)).toBeUndefined()
    expect(getSessionLeafOverride('/workspace/session-b.jsonl')).toBe('other-leaf')
  })

  it.each([
    { type: 'message', role: 'user', phase: 'start' },
    { type: 'message', role: 'assistant', phase: 'end' },
    { type: 'run', phase: 'started' },
    { type: 'run', phase: 'idle', settled: false },
  ])('keeps the rewind until a new prompt is persisted or the run settles (%j)', (event) => {
    const sessionFile = '/workspace/session-a.jsonl'
    setSessionLeafOverride(sessionFile, 'rewound-leaf')

    applySessionEventToSessionLeafOverride({
      ...event, sessionFile, seq: 1, workspaceId: '/workspace', timestamp: 1,
    } as AppEvent)

    expect(getSessionLeafOverride(sessionFile)).toBe('rewound-leaf')
  })

  it('should_keep_override_for_other_sessions_and_nonterminal_events', () => {
    const sessionFile = '/workspace/session-a.jsonl'
    setSessionLeafOverride(sessionFile, 'rewound-leaf')

    applySessionEventToSessionLeafOverride({
      type: 'run',
      phase: 'running',
      sessionFile,
      seq: 1,
      workspaceId: '/workspace',
      timestamp: 1,
    } as AppEvent)
    applySessionEventToSessionLeafOverride({
      type: 'run',
      phase: 'idle',
      settled: true,
      sessionFile: '/workspace/session-b.jsonl',
      seq: 2,
      workspaceId: '/workspace',
      timestamp: 2,
    } as AppEvent)

    expect(getSessionLeafOverride(sessionFile)).toBe('rewound-leaf')
  })
})

describe('noteSessionOwnerEpoch (handoff invalidate)', () => {
  it('keeps the leaf tip while the epoch is unchanged, drops it when a newer epoch claims the session', () => {
    const sessionFile = '/workspace/handoff-session.jsonl'
    setSessionLeafOverride(sessionFile, 'old-writer-leaf')

    // First sighting: record the epoch, keep the override (same writer, just confirmed).
    expect(noteSessionOwnerEpoch(sessionFile, 3)).toBe(false)
    expect(getSessionLeafOverride(sessionFile)).toBe('old-writer-leaf')

    // Same epoch again: no handoff, tip survives.
    expect(noteSessionOwnerEpoch(sessionFile, 3)).toBe(false)
    expect(getSessionLeafOverride(sessionFile)).toBe('old-writer-leaf')

    // Newer epoch: another process claimed the session via the T1 handoff — the in-memory
    // tip belongs to the previous writer's branch view and must be dropped.
    expect(noteSessionOwnerEpoch(sessionFile, 4)).toBe(true)
    expect(getSessionLeafOverride(sessionFile)).toBeUndefined()

    // Unknown/absent epochs never invalidate.
    setSessionLeafOverride(sessionFile, 'again')
    expect(noteSessionOwnerEpoch(sessionFile, undefined)).toBe(false)
    expect(getSessionLeafOverride(sessionFile)).toBe('again')
    clearSessionLeafOverride()
  })

  it('clearSessionLeafOverride also forgets the recorded epoch', () => {
    const sessionFile = '/workspace/epoch-clear.jsonl'
    noteSessionOwnerEpoch(sessionFile, 2)
    setSessionLeafOverride(sessionFile, 'tip')
    clearSessionLeafOverride(sessionFile)
    // After a full clear, the next sighting is a "first" (no invalidation) again.
    setSessionLeafOverride(sessionFile, 'tip2')
    expect(noteSessionOwnerEpoch(sessionFile, 2)).toBe(false)
    expect(getSessionLeafOverride(sessionFile)).toBe('tip2')
    clearSessionLeafOverride()
  })
})
