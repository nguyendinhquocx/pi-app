import { useState } from 'react'
import type { AgentRun } from './agent-runs'

/** Agents view for subagent-tab tool runs surfaced by the currently selected parent session. */
export function AgentsPanel({
  runs,
  onLoadDetail,
  onSteer,
  onAbort,
  onResume,
}: {
  runs: AgentRun[]
  onLoadDetail(toolCallId: string): Promise<string>
  onSteer(text: string): Promise<void>
  onAbort(): Promise<void>
  onResume(context: string): Promise<void>
}) {
  const [details, setDetails] = useState<Record<string, string>>({})
  const [steerFor, setSteerFor] = useState<string | null>(null)
  const [steerText, setSteerText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="agents-panel" aria-label="Agents">
      <h3>Agents</h3>
      {error && <p className="notice error" role="alert">{error}</p>}
      {runs.length === 0 && <p className="empty">Phiên này chưa gọi subagent.</p>}
      {runs.map((run) => (
        <article className="agent-run" key={`${run.turnId}:${run.toolCallId}`}>
          <header>
            <strong>{run.title}</strong>
            <span className={`agent-state ${run.status}`}>{run.status === 'running' ? 'Đang chạy' : run.status === 'failed' ? 'Thất bại' : 'Hoàn tất'}</span>
          </header>
          <p className="agent-progress">{run.progress}</p>
          {details[run.toolCallId] && <pre className="agent-result">{details[run.toolCallId]}</pre>}
          <div className="agent-actions">
            <button disabled={busy} onClick={() => void runAction(async () => {
              const detail = await onLoadDetail(run.toolCallId)
              setDetails((current) => ({ ...current, [run.toolCallId]: detail }))
            })}>Xem kết quả</button>
            {run.status === 'running' && (
              <>
                <button disabled={busy} onClick={() => { setSteerFor(steerFor === run.toolCallId ? null : run.toolCallId); setSteerText('') }}>Steer</button>
                <button className="danger" disabled={busy} onClick={() => void runAction(onAbort)}>Abort lượt cha</button>
              </>
            )}
            {run.status !== 'running' && (
              <button className="primary" disabled={busy} onClick={() => void runAction(async () => {
                const result = details[run.toolCallId] ?? await onLoadDetail(run.toolCallId)
                setDetails((d) => ({ ...d, [run.toolCallId]: result }))
                await onResume(`Tiếp tục từ kết quả subagent ${run.title}:\n${result || run.progress}`)
              })}>Tiếp tục từ kết quả</button>
            )}
          </div>
          {steerFor === run.toolCallId && (
            <form onSubmit={(e) => { e.preventDefault(); if (steerText.trim()) void runAction(async () => { await onSteer(steerText.trim()); setSteerFor(null); setSteerText('') }) }}>
              <input aria-label="Steer agent" value={steerText} onChange={(e) => setSteerText(e.target.value)} placeholder="Chỉ dẫn thêm cho lượt đang chạy…" />
              <button className="primary" disabled={busy || !steerText.trim()}>Gửi steer</button>
              <button type="button" onClick={() => setSteerFor(null)}>Huỷ</button>
            </form>
          )}
        </article>
      ))}
    </section>
  )
}
