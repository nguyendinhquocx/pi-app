import { beforeEach, describe, expect, it } from 'vitest'
import type { Turn, TurnPatch, UiRequest } from '@shared/remote'
import type { SessionTimeline } from './timeline-store'
import { emptyTimeline, apply, applyAll, prependOlder, addUi, removeUi } from './timeline-store'

let seqCounter = 0
const nextSeq = (): number => ++seqCounter

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_1',
    anchor: 'anchor_1',
    status: 'running',
    user: { text: 'Fix the bug', },
    activity: { counts: { read: 0, edit: 0, write: 0, run: 0, search: 0, think: 0, other: 0 }, failed: 0 },
    steps: [],
    answer: '',
    files: [],
    ...overrides,
  }
}

const turnPatch = (turn: Turn): TurnPatch => ({ op: 'turn.upsert', seq: nextSeq(), turn })

const stepPatch = (turnId: string, step: Turn['steps'][number], counts?: Partial<Turn['activity']['counts']>): TurnPatch => ({
  op: 'step.upsert',
  seq: nextSeq(),
  turnId,
  step,
  counts: { read: 0, edit: 0, write: 0, run: 0, search: 0, think: 0, other: 0, ...counts },
  failed: 0,
})

const textPatch = (turnId: string, ref: string, delta: string, seqTo?: number): TurnPatch => ({
  op: 'text.append',
  seq: nextSeq(),
  ...(seqTo !== undefined ? { seqTo } : {}),
  turnId,
  ref,
  delta,
})

const settlePatch = (turnId: string, status: 'done' | 'failed' | 'aborted' | 'running'): TurnPatch => ({
  op: 'turn.settle',
  seq: nextSeq(),
  turnId,
  status,
  files: [],
})

beforeEach(() => {
  seqCounter = 0
})

describe('timeline store — Android TurnStore semantics (spec T4 live timeline)', () => {
  it('turn.upsert inserts new and replaces by id then anchor', () => {
    let t = emptyTimeline()
    t = apply(t, turnPatch(makeTurn()))
    expect(t.turns).toHaveLength(1)
    t = apply(t, turnPatch(makeTurn({ id: 'turn_1', status: 'done', answer: 'done text' })))
    expect(t.turns).toHaveLength(1)
    expect(t.turns[0].answer).toBe('done text')
    // Same anchor, new id (live → saved id flip) replaces in place.
    t = apply(t, turnPatch(makeTurn({ id: 'turn_saved' })))
    expect(t.turns).toHaveLength(1)
    expect(t.turns[0].id).toBe('turn_saved')
  })

  it('step.upsert merges steps by id and updates activity', () => {
    let t = apply(emptyTimeline(), turnPatch(makeTurn()))
    const toolStep = {
      id: 'step_1',
      kind: 'tool' as const,
      toolCallId: 'call_1',
      toolName: 'bash',
      category: 'run' as const,
      status: 'running' as const,
      node: { template: 'bash', title: 'bash', fields: {}, status: 'running' as const, fallbackText: 'bash' },
    }
    t = apply(t, stepPatch('turn_1', toolStep, { run: 1 }))
    expect(t.turns[0].steps).toHaveLength(1)
    expect(t.turns[0].activity.counts.run).toBe(1)
    t = apply(t, stepPatch('turn_1', { ...toolStep, status: 'ok' }, { run: 2 }))
    expect(t.turns[0].steps[0]).toMatchObject({ status: 'ok' })
    expect(t.turns[0].activity.counts.run).toBe(2)
  })

  it('text.append streams into answer and thinking/prose steps by ref', () => {
    let t = apply(emptyTimeline(), turnPatch(makeTurn()))
    t = apply(t, textPatch('turn_1', 'answer', 'Hel'))
    t = apply(t, textPatch('turn_1', 'answer', 'lo'))
    expect(t.turns[0].answer).toBe('Hello')
    const think = { id: 's_think', kind: 'thinking' as const, text: '' }
    t = apply(t, stepPatch('turn_1', think))
    t = apply(t, textPatch('turn_1', 's_think', 'hmm '))
    t = apply(t, textPatch('turn_1', 's_think', 'ok'))
    expect((t.turns[0].steps[0] as { text: string }).text).toBe('hmm ok')
  })

  it('coalesced text.append advances seq to seqTo (stream coalescing contract)', () => {
    // seq advances ONLY through applyAll (TurnStore semantics) — build the base via applyAll.
    const base = applyAll(emptyTimeline(), [turnPatch(makeTurn())])
    expect(base.ok).toBe(true)
    const t: SessionTimeline = (base as { ok: true; timeline: SessionTimeline }).timeline
    const p = textPatch('turn_1', 'answer', 'x')
    const pAppend = p as Extract<TurnPatch, { op: 'text.append' }>
    const coalesced = {
      op: 'text.append' as const,
      seq: pAppend.seq,
      seqTo: pAppend.seq + 3,
      turnId: 'turn_1',
      ref: 'answer',
      delta: 'x',
    } as TurnPatch
    const after = applyAll(t, [coalesced])
    expect(after.ok).toBe(true)
    const advanced: SessionTimeline = (after as { ok: true; timeline: SessionTimeline }).timeline
    const coalescedAppend = coalesced as Extract<TurnPatch, { op: 'text.append' }>
    expect(advanced.seq).toBe(coalescedAppend.seqTo)
    expect(advanced.turns[0].answer).toBe('x')
    const follow = {
      op: 'text.append' as const,
      seq: (coalescedAppend.seqTo as number) + 1,
      turnId: 'turn_1',
      ref: 'answer',
      delta: 'y',
    } as TurnPatch
    const r = applyAll(advanced, [follow])
    expect(r.ok).toBe(true)
    expect((r as { ok: true; timeline: SessionTimeline }).timeline.turns[0].answer).toBe('xy')
  })

  it('turn.settle propagates error status to running tool steps and clears live', () => {
    let t = apply(emptyTimeline(), turnPatch(makeTurn()))
    const toolStep = {
      id: 's1',
      kind: 'tool' as const,
      toolCallId: 'c1',
      toolName: 'bash',
      category: 'run' as const,
      status: 'running' as const,
      node: { template: 'bash', title: 'b', fields: {}, status: 'running' as const, fallbackText: 'b' },
    }
    t = apply(t, stepPatch('turn_1', toolStep))
    t = apply(t, settlePatch('turn_1', 'failed'))
    expect((t.turns[0].steps[0] as { status: string }).status).toBe('error')
    expect(t.turns[0].activity.live).toBeUndefined()
    expect(t.turns[0].status).toBe('failed')
  })

  it('applyAll detects gaps (caller re-opens) and skips replay overlap', () => {
    let t = apply(emptyTimeline(), turnPatch(makeTurn()))
    const gapPatch: TurnPatch = { op: 'session.state', seq: t.seq + 5, state: { running: true } }
    const r = applyAll(t, [gapPatch])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.gap).toEqual({ expected: t.seq + 1, got: t.seq + 5 })
    // Overlap: same seq again is skipped.
    const overlap: TurnPatch = { op: 'session.state', seq: t.seq, state: { running: true } }
    const r2 = applyAll(t, [overlap])
    expect(r2.ok).toBe(true)
    expect((r2 as { ok: true; timeline: typeof t }).timeline.seq).toBe(t.seq)
  })

  it('timeline.reset drops turns but keeps hasOlder', () => {
    let t = apply(emptyTimeline(), turnPatch(makeTurn()))
    t = { ...t, hasOlder: true }
    const oldGeneration = t.timelineGeneration ?? 0
    t = apply(t, { op: 'timeline.reset', seq: nextSeq() })
    expect(t.turns).toHaveLength(0)
    expect(t.hasOlder).toBe(true)
    expect(t.timelineGeneration).toBe(oldGeneration + 1)
  })

  it('prependOlder dedupes by anchor and keeps order', () => {
    let t = apply(emptyTimeline(), turnPatch(makeTurn({ id: 't2', anchor: 'a2' })))
    t = prependOlder(t, [makeTurn({ id: 't1', anchor: 'a1' }), makeTurn({ id: 't2', anchor: 'a2' })], true)
    expect(t.turns.map((x) => x.anchor)).toEqual(['a1', 'a2'])
    expect(t.hasOlder).toBe(true)
  })

  it('pendingUi: notify never enters, dup id ignored, dismiss removes', () => {
    let t = emptyTimeline()
    const ask: UiRequest = { id: 'u1', sessionKey: 's', method: 'select', title: 'Pick', options: ['a', 'b'] }
    const notify: UiRequest = { id: 'u2', sessionKey: 's', method: 'notify', message: 'hi' }
    t = addUi(t, notify)
    expect(t.pendingUi).toHaveLength(0)
    t = addUi(t, ask)
    t = addUi(t, { ...ask })
    expect(t.pendingUi).toHaveLength(1)
    t = removeUi(t, 'u1')
    expect(t.pendingUi).toHaveLength(0)
  })
})
