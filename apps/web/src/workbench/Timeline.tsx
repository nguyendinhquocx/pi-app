import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bot, Check, Copy } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { sanitizeHtml } from '../features/markdown'
import type { Turn, RenderNode } from '@shared/remote'
import type { SessionTimeline } from './timeline-store'
import { anchorAdjustment } from './timeline-store'

/**
 * Live timeline (spec T3): turns + quiet tool rows + markdown answer. History paging reuses the
 * existing `turn.page` RPC — loading starts when the viewport nears the top, one request per
 * session, and a manual scroll-anchor correction keeps the content the user is reading within
 * 8px after the prepend. Follow-live only pulls the user down while they sit near the bottom;
 * leaving the bottom detaches it until they scroll back or press "Về cuối".
 */

export type TimelineActions = {
  onToolDetail(sessionKey: string, toolCallId: string): Promise<string>
}

const TOP_TRIGGER_PX = 64
const FOLLOW_THRESHOLD_PX = 80

/** Manual scroll anchoring: shift needed after DOM growth to keep the viewport content fixed. */
export function keepAnchorWithin8px(prevHeight: number, newHeight: number): number {
  const delta = anchorAdjustment(prevHeight, newHeight)
  return Math.abs(delta) <= 8 ? 0 : delta
}

function statusClass(status: string): string {
  return status === 'running' ? 'live' : status === 'error' ? 'error' : ''
}

/** Hover-only copy chip (LiX pattern): icon flips to a check for a moment after copying. */
function CopyButton({ getText, label }: { getText: () => string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  const onCopy = () => {
    const text = getText()
    if (!text) return
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    }).catch(() => undefined)
  }
  return (
    <button type="button" className="copy-chip" onClick={onCopy} aria-label={copied ? 'Đã sao chép' : label} title={copied ? 'Đã sao chép' : label}>
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  )
}

/** Quiet tool row (spec T3): success renders no raw `ok` label; running keeps a small cue;
 * failure keeps a readable state and the detail stays one click away. */
const ToolCard = memo(function ToolCard({ step, sessionKey, onDetail }: { step: Extract<Turn['steps'][number], { kind: 'tool' }>; sessionKey: string; onDetail: TimelineActions['onToolDetail'] }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const node: RenderNode = step.node
  const failed = step.status === 'error'
  const running = step.status === 'running'
  const duration = step.ms ? ` · ${(step.ms / 1000).toFixed(1)}s` : ''
  return (
    <div className={`tool-row ${statusClass(step.status)}`} data-tool={step.toolName}>
      <button className="tool-head" onClick={() => {
        setOpen(!open)
        if (!open && node.detail && detail === null) {
          void onDetail(sessionKey, step.toolCallId).then((d) => setDetail(d)).catch(() => setDetail(''))
        }
      }} aria-expanded={open} aria-label={failed ? `${node.title || step.toolName}; lệnh thất bại, mở để xem chi tiết` : undefined}>
        <span className="tool-name">{node.title || step.toolName}</span>
        {running && (
          <span className="tool-status live">
            <span className="pulse-dot" aria-hidden="true" />
            <span className="sr-only">đang chạy</span>
          </span>
        )}
        {!running && !failed && duration && <span className="tool-duration">{duration}</span>}
        {failed && <span className="tool-failure-dot" aria-hidden="true" title="Lệnh thất bại; mở để xem chi tiết" />}
        {/* Failure stays accessible on the trigger and in the expanded detail; don't splash raw errors into the transcript. */}
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
  const streaming = turn.status === 'running'
  return (
    <article className={`turn ${turn.status}`} data-turn-id={turn.id}>
      <div className="turn-user">
        <p>{turn.user.text}</p>
      </div>
      <div className="turn-actions-row turn-user-actions">
        <CopyButton getText={() => turn.user.text} label="Sao chép tin nhắn" />
      </div>
      <div className="turn-assistant">
        <div className="assistant-avatar" aria-hidden="true"><Bot size={17} /></div>
        <div className="assistant-content">
          {turn.steps.map((step) => {
            // Provider text/thinking deltas may interleave at token granularity while the turn
            // is live. Keep only real tools visible; settle reveals the authoritative transcript.
            if (streaming && step.kind !== 'tool') return null
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
          {!streaming && turn.answer && (
            <div className="markdown turn-answer">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{turn.answer}</ReactMarkdown>
              <div className="turn-actions-row turn-answer-actions">
                <CopyButton getText={() => turn.answer} label="Sao chép câu trả lời" />
              </div>
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
          {turn.error && !streaming && <p className={`turn-error ${turn.error.kind}`}>{turn.error.kind}: {turn.error.text}</p>}
        </div>
      </div>
    </article>
  )
}

/** Tool previews may arrive as HTML from adapters — sanitize through the strict profile. */
export function SafePreviewHtml({ html }: { html: string }) {
  return <div className="markdown safe-preview" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
}

type OlderStatus = 'idle' | 'loading' | 'error'

export function Timeline({ timeline, sessionKey, actions, onLoadOlder }: {
  timeline: SessionTimeline
  sessionKey: string
  actions: TimelineActions
  onLoadOlder(sessionKey: string, before: string): Promise<void>
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [olderStatus, setOlderStatus] = useState<OlderStatus>('idle')
  const [follow, setFollow] = useState(true)
  const [showJump, setShowJump] = useState(false)
  const followRef = useRef(true)
  const inFlight = useRef(false)
  const prevTurns = useRef<{ len: number; first: string | null; height: number }>({ len: 0, first: null, height: 0 })

  const setFollowState = useCallback((next: boolean) => {
    followRef.current = next
    setFollow(next)
    setShowJump(!next)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo?.({ top: el.scrollHeight })
    setFollowState(true)
  }, [setFollowState])

  // Scroll-anchor correction after history prepends + follow-live streaming (spec T3).
  useLayoutEffect(() => {
    const el = scrollRef.current
    const first = timeline.turns[0]?.anchor ?? null
    if (!el) {
      prevTurns.current = { len: timeline.turns.length, first, height: 0 }
      return
    }
    const prev = prevTurns.current
    const prepended = prev.first !== null && first !== prev.first && timeline.turns.length > prev.len
    if (prepended) {
      const shift = keepAnchorWithin8px(prev.height, el.scrollHeight)
      if (shift !== 0) el.scrollTop += shift
    } else if (followRef.current) {
      el.scrollTo?.({ top: el.scrollHeight })
    }
    prevTurns.current = { len: timeline.turns.length, first, height: el.scrollHeight }
  }, [timeline.turns])

  // A different session reopens the timeline: reset paging + follow state.
  useEffect(() => {
    setOlderStatus('idle')
    inFlight.current = false
    setFollowState(true)
    prevTurns.current = { len: 0, first: null, height: 0 }
  }, [sessionKey, setFollowState])

  const triggerLoadOlder = useCallback(async () => {
    const first = timeline.turns[0]?.anchor
    if (!timeline.hasOlder || !first || inFlight.current || olderStatus === 'loading') return
    inFlight.current = true
    setOlderStatus('loading')
    try {
      await onLoadOlder(sessionKey, first)
      setOlderStatus('idle')
    } catch (e) {
      setOlderStatus('error')
      setOlderMessage(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
    }
  }, [timeline.hasOlder, timeline.turns, sessionKey, onLoadOlder, olderStatus])

  const [olderMessage, setOlderMessage] = useState<string | null>(null)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromTop = el.scrollTop
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setFollowState(distanceFromBottom <= FOLLOW_THRESHOLD_PX)
    if (distanceFromTop <= TOP_TRIGGER_PX) void triggerLoadOlder()
  }, [triggerLoadOlder, setFollowState])

  const hasOlder = timeline.hasOlder
  const endOfHistory = !hasOlder && olderStatus === 'idle' && timeline.turns.length > 0
  const isRunning = timeline.state.running || timeline.turns.some((turn) => turn.status === 'running')

  return (
    <div className="timeline-wrap">
      {olderStatus === 'loading' && <div className="older-state" role="status" aria-live="polite">Đang tải các lượt cũ hơn…</div>}
      {olderStatus === 'error' && (
        <div className="older-state error" role="alert">
          <span>Không tải được lượt cũ hơn{olderMessage ? ` — ${olderMessage}` : ''}.</span>
          <button onClick={() => void triggerLoadOlder()}>Thử lại</button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="timeline"
        role="log"
        aria-live="off"
        onScroll={handleScroll}
        data-follow={follow ? 'live' : 'detached'}
      >
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
        {endOfHistory && <div className="older-end" aria-hidden="true">Đầu phiên</div>}
        {timeline.turns.map((turn: Turn) => (
          <TurnView key={turn.id} turn={turn} sessionKey={sessionKey} actions={actions} />
        ))}
        {isRunning && (
          <div className="stream-indicator" role="status">Đang chạy…</div>
        )}
      </div>
      {showJump && (
        <button className="jump-latest" onClick={() => scrollToBottom()}>
          Về cuối
        </button>
      )}
    </div>
  )
}
