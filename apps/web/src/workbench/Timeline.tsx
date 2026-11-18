import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { sanitizeHtml } from '../features/markdown'
import type { Turn, RenderNode } from '@shared/remote'
import type { SessionTimeline } from './timeline-store'

/**
 * Live timeline (spec T4): turns + tool cards + markdown answer, streaming patches already
 * merged by the store. Raw HTML in assistant text never renders (no rehype-raw); tool previews
 * (plain text) render as code blocks; anything HTML-shaped goes through the DOMPurify profile.
 * Message hover actions expose rewind/fork (overlay actions, spec parity row 6).
 */

export type TimelineActions = {
  onRewind(sessionKey: string, anchor: string): Promise<void>
  onFork(sessionKey: string, anchor: string): Promise<void>
  onToolDetail(sessionKey: string, toolCallId: string): Promise<string>
}

function statusClass(status: string): string {
  return status === 'running' ? 'live' : status === 'error' ? 'error' : ''
}

const ToolCard = memo(function ToolCard({ step, sessionKey, onDetail }: { step: Extract<Turn['steps'][number], { kind: 'tool' }>; sessionKey: string; onDetail: TimelineActions['onToolDetail'] }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const node: RenderNode = step.node
  return (
    <div className={`tool-card ${statusClass(step.status)}`} data-tool={step.toolName}>
      <button className="tool-head" onClick={() => {
        setOpen(!open)
        if (!open && node.detail && detail === null) {
          void onDetail(sessionKey, step.toolCallId).then((d) => setDetail(d)).catch(() => setDetail(''))
        }
      }} aria-expanded={open}>
        <span className="tool-name">{node.title || step.toolName}</span>
        <span className={`tool-status ${statusClass(step.status)}`}>{step.status}{step.ms ? ` · ${(step.ms / 1000).toFixed(1)}s` : ''}</span>
      </button>
      {open && (
        <div className="tool-body">
          {node.preview && <pre className="tool-preview">{node.preview}</pre>}
          {detail !== null && <pre className="tool-detail">{detail || '(no detail)'}</pre>}
          {!node.preview && !node.detail && <pre className="tool-preview">{node.fallbackText}</pre>}
        </div>
      )}
    </div>
  )
})

function TurnView({ turn, sessionKey, actions }: { turn: Turn; sessionKey: string; actions: TimelineActions }) {
  const [confirming, setConfirming] = useState<'rewind' | 'fork' | null>(null)
  return (
    <article className={`turn ${turn.status}`} data-turn-id={turn.id}>
      <div className="turn-user">
        <p>{turn.user.text}</p>
        <div className="turn-hover-actions">
          <button onClick={() => setConfirming(confirming === 'rewind' ? null : 'rewind')} aria-label="Quay lại đây (rewind)">↺ rewind</button>
          <button onClick={() => setConfirming(confirming === 'fork' ? null : 'fork')} aria-label="Nhánh mới từ đây (fork)">⑂ fork</button>
        </div>
        {confirming && (
          <div className="confirm-strip" role="alertdialog" aria-label={`Xác nhận ${confirming}`}>
            <span>{confirming === 'rewind' ? 'Quay phiên về tin nhắn này?' : 'Tạo nhánh mới từ tin nhắn này?'}</span>
            <button className="primary" onClick={() => {
              void (confirming === 'rewind' ? actions.onRewind(sessionKey, turn.anchor) : actions.onFork(sessionKey, turn.anchor))
              setConfirming(null)
            }}>Xác nhận</button>
            <button onClick={() => setConfirming(null)}>Huỷ</button>
          </div>
        )}
      </div>
      {turn.steps.map((step) => {
        if (step.kind === 'thinking') {
          return (
            <details key={step.id} className="thinking-block">
              <summary>Thinking{step.ms ? ` · ${(step.ms / 1000).toFixed(1)}s` : ''}</summary>
              <div className="markdown">{step.text}</div>
            </details>
          )
        }
        if (step.kind === 'tool') {
          return <ToolCard key={step.id} step={step} sessionKey={sessionKey} onDetail={actions.onToolDetail} />
        }
        return <div key={step.id} className="markdown prose-step">{step.text}</div>
      })}
      {turn.answer && (
        <div className="markdown turn-answer">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{turn.answer}</ReactMarkdown>
        </div>
      )}
      {turn.files.length > 0 && (
        <p className="turn-files">
          {turn.files.map((f) => (
            <span key={f.path} className="file-chip">
              <code>{f.path}</code> <span className="muted">+{f.add}/−{f.del}</span>
            </span>
          ))}
        </p>
      )}
      {turn.error && <p className={`turn-error ${turn.error.kind}`}>{turn.error.kind}: {turn.error.text}</p>}
    </article>
  )
}

/** Tool previews may arrive as HTML from adapters — sanitize through the strict profile. */
export function SafePreviewHtml({ html }: { html: string }) {
  return <div className="markdown safe-preview" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
}

export function Timeline({ timeline, sessionKey, actions, onLoadOlder }: {
  timeline: SessionTimeline
  sessionKey: string
  actions: TimelineActions
  onLoadOlder(sessionKey: string, before: string): Promise<void>
}) {
  return (
    <div className="timeline" role="log" aria-live="polite">
      {timeline.state.todo && (
        <section className="todo-widget" aria-label="Session todo">
          <strong>{timeline.state.todo.title}</strong>
          <ul>
            {timeline.state.todo.items.map((item) => (
              <li key={item.id} className={`todo-${item.status}`}>
                <span aria-hidden="true">{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▸' : item.status === 'cancelled' ? '×' : '○'}</span>
                {item.text}
              </li>
            ))}
          </ul>
        </section>
      )}
      {timeline.hasOlder && (
        <button className="load-older" onClick={() => {
          const first = timeline.turns[0]?.anchor
          if (first) void onLoadOlder(sessionKey, first)
        }}>
          Xem các lượt cũ hơn
        </button>
      )}
      {timeline.turns.length === 0 && <div className="empty">Chưa có nội dung — gửi tin nhắn đầu tiên.</div>}
      {timeline.turns.map((turn: Turn) => (
        <TurnView key={turn.id} turn={turn} sessionKey={sessionKey} actions={actions} />
      ))}
      {timeline.state.running && (
        <div className="stream-indicator" role="status">Đang chạy…</div>
      )}
    </div>
  )
}
