import type { Turn, TurnPatch, SessionState } from '@shared/remote'
import type { WebUiRequest } from '../transport/web-ui-request'

/** Mirrors the Android TurnStore patch/gap semantics; renders only host-projected data. */
export type SessionTimeline = {
  turns: Turn[]
  seq: number
  state: SessionState
  pendingUi: WebUiRequest[]
  hasOlder: boolean
}

export const emptyTimeline = (): SessionTimeline => ({ turns: [], seq: 0, state: { running: false }, pendingUi: [], hasOlder: false })

export type ApplyResult =
  | { ok: true; timeline: SessionTimeline }
  | { ok: false; gap: { expected: number; got: number } }

export function prependOlder(t: SessionTimeline, older: Turn[], hasOlder: boolean): SessionTimeline {
  const known = new Set(t.turns.map((turn) => turn.anchor))
  return { ...t, turns: [...older.filter((turn) => !known.has(turn.anchor)), ...t.turns], hasOlder }
}

export function applyAll(start: SessionTimeline, patches: TurnPatch[]): ApplyResult {
  let timeline = start
  for (const patch of patches) {
    const last = patch.op === 'text.append' && patch.seqTo !== undefined ? patch.seqTo : patch.seq
    if (last <= timeline.seq) continue
    if (patch.seq !== timeline.seq + 1) return { ok: false, gap: { expected: timeline.seq + 1, got: patch.seq } }
    timeline = { ...apply(timeline, patch), seq: last }
  }
  return { ok: true, timeline }
}

function mapTurn(timeline: SessionTimeline, turnId: string, update: (turn: Turn) => Turn): SessionTimeline {
  const index = timeline.turns.findIndex((turn) => turn.id === turnId)
  if (index < 0) return timeline
  const turns = [...timeline.turns]
  turns[index] = update(turns[index])
  return { ...timeline, turns }
}

function upsertStep(turn: Turn, step: Turn['steps'][number]): Turn {
  const index = turn.steps.findIndex((item) => item.id === step.id)
  const steps = index < 0 ? [...turn.steps, step] : turn.steps.map((item, i) => i === index ? step : item)
  return { ...turn, steps }
}

export function apply(timeline: SessionTimeline, patch: TurnPatch): SessionTimeline {
  switch (patch.op) {
    case 'turn.upsert': {
      const byId = timeline.turns.findIndex((turn) => turn.id === patch.turn.id)
      const index = byId >= 0 ? byId : timeline.turns.findIndex((turn) => turn.anchor === patch.turn.anchor)
      if (index >= 0) {
        const turns = [...timeline.turns]
        turns[index] = patch.turn
        return { ...timeline, turns }
      }
      return { ...timeline, turns: [...timeline.turns, patch.turn] }
    }
    case 'step.upsert':
      return mapTurn(timeline, patch.turnId, (turn) => ({
        ...upsertStep(turn, patch.step),
        activity: { ...turn.activity, counts: patch.counts, failed: patch.failed, live: patch.live },
      }))
    case 'text.append':
      return mapTurn(timeline, patch.turnId, (turn) => {
        if (patch.ref === 'answer') return { ...turn, answer: turn.answer + patch.delta }
        return {
          ...turn,
          steps: turn.steps.map((step) => {
            if (step.id !== patch.ref) return step
            if (step.kind === 'thinking' || step.kind === 'prose') return { ...step, text: step.text + patch.delta }
            return step
          }),
        }
      })
    case 'turn.promote':
      return mapTurn(timeline, patch.turnId, (turn) => upsertStep({ ...turn, answer: '' }, patch.step))
    case 'turn.settle':
      return mapTurn(timeline, patch.turnId, (turn) => {
        const steps = patch.status === 'running' ? turn.steps : turn.steps.map((step) =>
          step.kind === 'tool' && step.status === 'running'
            ? { ...step, status: 'error' as const, node: { ...step.node, status: 'error' as const } }
            : step,
        )
        return {
          ...turn,
          status: patch.status,
          durationMs: patch.durationMs ?? turn.durationMs,
          files: patch.files,
          error: patch.error,
          steps,
          activity: { ...turn.activity, live: undefined },
        }
      })
    case 'session.state':
      return { ...timeline, state: patch.state }
    case 'timeline.reset':
      return { ...emptyTimeline(), hasOlder: timeline.hasOlder }
    default:
      return timeline
  }
}

export function addUi(timeline: SessionTimeline, request: WebUiRequest): SessionTimeline {
  if (request.method === 'notify' || timeline.pendingUi.some((current) => current.id === request.id)) return timeline
  return { ...timeline, pendingUi: [...timeline.pendingUi, request] }
}

export function removeUi(timeline: SessionTimeline, id: string): SessionTimeline {
  return { ...timeline, pendingUi: timeline.pendingUi.filter((request) => request.id !== id) }
}
