import type { Turn } from '@shared/remote'

export type AgentRun = {
  turnId: string
  sessionKey: string
  toolCallId: string
  title: string
  status: 'running' | 'completed' | 'failed'
  progress: string
  preview: string | undefined
}

/**
 * Derive the Agents view from the parent's live subagent tool steps. The T2 SessionSummary wire
 * does not carry child→parent IDs, so deep child-session navigation is deliberately excluded;
 * this view still shows the child task/run, progress, result, and controls scoped to its parent.
 */
export function agentRunsFromTurns(turns: Turn[], sessionKey: string): AgentRun[] {
  const runs: AgentRun[] = []
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.kind !== 'tool' || !/subagent[-_]tab|subagent/i.test(step.toolName)) continue
      runs.push({
        turnId: turn.id,
        sessionKey,
        toolCallId: step.toolCallId,
        title: step.node.title || step.toolName,
        status: step.status === 'running' ? 'running' : step.status === 'error' ? 'failed' : 'completed',
        progress: step.node.preview || step.node.fallbackText,
        preview: step.node.preview,
      })
    }
  }
  return runs
}
