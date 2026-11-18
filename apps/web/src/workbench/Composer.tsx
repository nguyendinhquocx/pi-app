import { useRef, useState } from 'react'
import type { CommandInfo } from '@shared/remote'
import type { ContextStats, SessionUsage } from '@shared/remote'
import { prepareAttachment, AttachmentTooLargeError, type PreparedAttachment } from '../features/upload'

/**
 * Composer (spec T4): send/steer/followUp modes, slash command list (from command.list — server
 * completions excluded in the matrix), @file mention search, prompt-only attachment ≤10 MiB,
 * context/cost metrics footer, pending queue with dequeue.
 */

export type ComposerActions = {
  onSend(text: string, mode: 'prompt' | 'steer' | 'followUp', clientMessageId: string): Promise<void>
  onAbort(): Promise<{ aborted: boolean; wasRunning?: boolean; stopped?: boolean; restored?: string[] }>
  onDequeue(): Promise<string[]>
  onFileSearch(query: string): Promise<{ path: string }[]>
  onAttach(att: PreparedAttachment): Promise<{ path: string; name: string; size: number }>
}

function messageId(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function Composer({
  sessionKey,
  running,
  queue,
  commands,
  context,
  usage,
  model,
  thinking,
  thinkingLevels,
  models,
  onSetModel,
  onSetThinking,
  actions,
}: {
  sessionKey: string
  running: boolean
  queue: { steering: string[]; followUp: string[] }
  commands: CommandInfo[]
  context: ContextStats | null
  usage: SessionUsage | null
  model: string | null
  thinking: string | null
  thinkingLevels: string[]
  models: { id: string; name: string }[]
  onSetModel(modelId: string): Promise<void>
  onSetThinking(level: string): Promise<void>
  actions: ComposerActions
}) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'prompt' | 'steer' | 'followUp'>('prompt')
  const [error, setError] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [mention, setMention] = useState<{ query: string; results: { path: string }[] } | null>(null)
  const queuedMessages = [...queue.steering, ...queue.followUp]
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const send = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) return
    setError(null)
    const effectiveMode = running && mode === 'prompt' ? 'steer' : mode
    try {
      await actions.onSend(trimmed, effectiveMode, messageId())
      setText('')
      setMode(running ? 'followUp' : 'prompt')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onTextChange = (value: string): void => {
    setText(value)
    // @mention: last unclosed @token triggers a file search (debounced by the caller's RPC).
    const atMatch = /(?:^|\s)@([\w\-./]*)$/.exec(value)
    if (atMatch) {
      const q = atMatch[1]
      setMention({ query: q, results: [] })
      void actions.onFileSearch(q).then((results) => {
        setMention((cur) => (cur && cur.query === q ? { ...cur, results } : cur))
      }).catch(() => setMention(null))
    } else {
      setMention(null)
    }
    // Slash: first token completion from the local command list (no server resolve in v1).
  }

  const slashMatches = text.startsWith('/') ? commands.filter((c) => c.name.startsWith(text.slice(1).split(' ')[0])).slice(0, 8) : []

  const pickAttachment = async (): Promise<void> => {
    setAttaching(true)
    setError(null)
    try {
      const input = document.createElement('input')
      input.type = 'file'
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) {
          setAttaching(false)
          return
        }
        void prepareAttachment(file)
          .then((att) => actions.onAttach(att))
          .then((uploaded) => {
            // The host saves the bytes locally and returns the host-local path. Add the @file
            // reference to the prompt; the upload itself never starts a turn.
            const normalized = uploaded.path.replace(/\\/g, '/')
            const escaped = normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            const reference = /\s/.test(normalized) ? `@"${escaped}"` : `@${escaped}`
            setText((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${reference} `)
            inputRef.current?.focus()
          })
          .catch((e) => setError(e instanceof AttachmentTooLargeError ? 'Tệp vượt 10 MiB — giới hạn prompt-only' : e.message))
          .finally(() => setAttaching(false))
      }
      input.click()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setAttaching(false)
    }
  }

  const tokens = context?.tokens ?? 0
  const windowTokens = context?.window ?? 0
  const pct = windowTokens > 0 ? Math.round((tokens / windowTokens) * 100) : 0

  return (
    <section className="composer" aria-label="Composer">
      {slashMatches.length > 0 && (
        <ul className="slash-popover" role="listbox" aria-label="Slash commands">
          {slashMatches.map((c) => (
            <li key={`${c.category}:${c.name}`}>
              <button onClick={() => { setText(`/${c.name} `); inputRef.current?.focus() }}>
                <code>/{c.name}</code> <span className="muted">{c.category}</span> {c.description}
              </button>
            </li>
          ))}
        </ul>
      )}
      {mention && (
        <ul className="mention-popover" role="listbox" aria-label="File mention">
          {mention.results.slice(0, 8).map((f) => (
            <li key={f.path}>
              <button onClick={() => { setText(text.replace(/@[\w\-./]*$/, `@${f.path} `)); setMention(null); inputRef.current?.focus() }}>
                {f.path}
              </button>
            </li>
          ))}
          {mention.results.length === 0 && <li className="empty">Không thấy file khớp.</li>}
        </ul>
      )}
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
        placeholder={running ? 'Đang chạy — gửi steer/follow-up…' : 'Gõ tin nhắn, / lệnh, @file…'}
        aria-label="Tin nhắn"
      />
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="composer-footer">
        <div className="composer-modes" role="radiogroup" aria-label="Chế độ gửi">
          {(['prompt', 'steer', 'followUp'] as const).map((m) => (
            <label key={m} className={mode === m ? 'on' : ''}>
              <input type="radio" name="send-mode" checked={mode === m} onChange={() => setMode(m)} />
              {m === 'prompt' ? 'Gửi' : m === 'steer' ? 'Steer' : 'Follow-up'}
            </label>
          ))}
        </div>
        <select aria-label="Model" value={model ?? ''} onChange={(e) => void onSetModel(e.target.value)}>
          {models.length === 0 && <option value="">model</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <select aria-label="Thinking level" value={thinking ?? ''} onChange={(e) => void onSetThinking(e.target.value)}>
          <option value="">thinking</option>
          {(thinkingLevels.length > 0 ? thinkingLevels : ['off', 'minimal', 'low', 'medium', 'high']).map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <button onClick={() => void pickAttachment()} disabled={attaching} aria-label="Đính kèm tệp (prompt-only, tối đa 10 MiB)">
          📎{attaching ? '…' : ''}
        </button>
        {queuedMessages.length > 0 && (
          <details className="composer-queue">
            <summary>Hàng đợi ({queuedMessages.length})</summary>
            <ul>{queuedMessages.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
            <button onClick={() => void actions.onDequeue().then((restored) => setText(restored.join('\n')))} title="Lấy nội dung khỏi hàng đợi">Lấy lại</button>
          </details>
        )}
        <span className="composer-metrics" title={usage ? `Cost $${usage.cost.toFixed(4)} · ${usage.calls} calls` : undefined}>
          {tokens > 0 ? `${tokens.toLocaleString()} tok${windowTokens ? ` (${pct}%)` : ''}` : ''}
          {usage ? ` · $${usage.cost.toFixed(4)}` : ''}
        </span>
        {running ? (
          <button className="danger" onClick={() => void actions.onAbort().then((result) => {
            if (result.wasRunning && !result.stopped) setError('Host chưa xác nhận đã dừng — lượt vẫn có thể đang chạy.')
          }).catch((e) => setError(e.message))}>Abort</button>
        ) : (
          <button className="primary" onClick={() => void send()} disabled={!text.trim()}>Gửi</button>
        )}
      </div>
    </section>
  )
}
