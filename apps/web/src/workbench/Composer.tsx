import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, ChevronRight, Paperclip } from 'lucide-react'
import type { CommandInfo } from '@shared/remote'
import type { ContextStats, SessionUsage } from '@shared/remote'
import { prepareAttachment, AttachmentTooLargeError, type PreparedAttachment } from '../features/upload'

/**
 * Composer (spec T4): send/steer/followUp modes behind a compact menu, searchable model popover
 * grouped by provider (never filters a model the host reports as available), optimistic current
 * model after `model.set`, @file mention search, prompt-only attachment ≤10 MiB, and a single
 * context cue that only appears near the window limit — cost/token noise lives in Inspector →
 * Context.
 */

export type ModelOption = { id: string; name: string; provider?: string; group?: string }

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

const RECENT_MODELS_KEY = 'li-web-recent-models'

/** Device-local recent models (spec T2: device-local prefs never reach the host). */
export function readRecentModels(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string').slice(0, 5) : []
  } catch {
    return []
  }
}

function rememberRecentModel(id: string): void {
  try {
    const next = [id, ...readRecentModels().filter((m) => m !== id)].slice(0, 5)
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next))
  } catch { /* private mode */ }
}

const MODE_LABEL: Record<'prompt' | 'steer' | 'followUp', string> = { prompt: 'Gửi', steer: 'Steer', followUp: 'Follow-up' }

/** Searchable model popover (spec T4 UX contract): recents first, provider groups collapsed
 * except the active one — mirrors the LiX desktop picker instead of dumping the whole catalog. */
function ModelPicker({ models, current, sessionKey, onSetModel, onError }: {
  models: ModelOption[]
  current: string | null
  sessionKey: string
  onSetModel(modelId: string): Promise<void>
  onError(message: string): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Optimistic selection (spec T4): reflect the picked model immediately, never let the last
  // turn's meta.model overwrite it before the next turn arrives.
  const [pending, setPending] = useState<string | null>(null)
  const [modelChangeInFlight, setModelChangeInFlight] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // Session switch resets the optimistic override; the host truth takes over again.
    setPending(null)
    setModelChangeInFlight(false)
    setOpen(false)
  }, [sessionKey])
  useEffect(() => {
    if (pending && current === pending) setPending(null)
  }, [current, pending])
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.model-picker')) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const effective = pending ?? current
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) => `${m.id} ${m.name} ${m.provider ?? ''}`.toLowerCase().includes(q))
  }, [models, query])
  const searching = query.trim().length > 0
  const recentModels = useMemo(() => {
    if (searching) return []
    const recents = readRecentModels()
    const seen = new Set<string>()
    const rows: ModelOption[] = []
    for (const id of recents) {
      const m = filtered.find((item) => item.id === id)
      if (m && !seen.has(m.id)) { rows.push(m); seen.add(m.id) }
    }
    return rows
  }, [filtered, searching])
  const grouped = useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const m of filtered) {
      if (!searching && recentModels.some((r) => r.id === m.id)) continue
      const key = m.provider || 'Khác'
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [filtered, recentModels, searching])
  const visibleGroups = useMemo(
    () => grouped.map(([provider, list]) => ({
      provider,
      list,
      open: searching || collapsed[provider] === undefined ? provider === (models.find((m) => m.id === effective)?.provider || 'Khác') || searching : !collapsed[provider],
    })),
    [grouped, collapsed, effective, models, searching],
  )
  const flat = useMemo(
    () => [...recentModels, ...visibleGroups.flatMap((g) => (g.open ? g.list : []))],
    [recentModels, visibleGroups],
  )
  const currentName = models.find((m) => m.id === effective)?.name ?? effective

  const renderOption = (m: ModelOption) => {
    const index = flat.indexOf(m)
    const selected = m.id === effective
    return (
      <li key={m.id}>
        <button
          id={`model-opt-${index}`}
          role="option"
          aria-selected={selected}
          data-model-id={m.id}
          className={`model-option ${index === active ? 'active' : ''}`}
          onMouseEnter={() => setActive(index)}
          onClick={() => void pick(m.id)}
        >
          <span className="model-option-name">{m.name || m.id}</span>
          {m.group && <span className="model-option-group">{m.group}</span>}
          {selected && <span className="model-option-check" aria-hidden="true">✓</span>}
          {selected && <span className="sr-only">đang dùng</span>}
        </button>
      </li>
    )
  }

  const close = (): void => {
    setOpen(false)
    setQuery('')
    triggerRef.current?.focus()
  }

  const pick = async (id: string): Promise<void> => {
    setOpen(false)
    setQuery('')
    rememberRecentModel(id)
    setPending(id)
    setModelChangeInFlight(true)
    triggerRef.current?.focus()
    try {
      await onSetModel(id)
      setModelChangeInFlight(false)
    } catch (e) {
      setPending(null)
      setModelChangeInFlight(false)
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const move = (delta: number): void => {
    if (flat.length === 0) return
    setActive((i) => (i + delta + flat.length) % flat.length)
  }

  return (
    <div className="model-picker">
      <button
        ref={triggerRef}
        className="model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${currentName ?? 'chưa chọn'}`}
        aria-busy={modelChangeInFlight}
        onClick={() => {
          if (open) { close(); return }
          setOpen(true)
          setQuery('')
          setActive(Math.max(0, models.findIndex((m) => m.id === effective)))
        }}
      >
        <span className="model-trigger-label">{currentName ?? 'Model'}</span>
        {modelChangeInFlight && (
          <>
            <span className="pulse-dot" aria-hidden="true" />
            <span className="sr-only">đang áp dụng</span>
          </>
        )}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="model-popover" role="group" aria-label="Chọn model">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            placeholder="Tìm model hoặc provider…"
            aria-label="Tìm model"
            role="combobox"
            aria-expanded="true"
            aria-controls="model-option-list"
            aria-activedescendant={flat[active] ? `model-opt-${active}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
              else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
              else if (e.key === 'End') { e.preventDefault(); setActive(flat.length - 1) }
              else if (e.key === 'Enter') {
                e.preventDefault()
                const target = flat[active]
                if (target) void pick(target.id)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
          />
          {flat.length === 0 ? (
            <p className="picker-empty" role="status">Không có model khớp “{query}”.</p>
          ) : (
            <ul id="model-option-list" role="listbox" aria-label="Models" className="model-list">
              {recentModels.length > 0 && (
                <li className="model-group model-group-recent">
                  <div className="model-group-label">Gần đây</div>
                  <ul role="presentation">
                    {recentModels.map((m) => renderOption(m))}
                  </ul>
                </li>
              )}
              {visibleGroups.map(({ provider, list, open }) => (
                <li key={provider} className={`model-group ${open ? '' : 'model-group-collapsed'}`}>
                  <button
                    type="button"
                    className="model-group-label model-group-toggle"
                    aria-expanded={open}
                    onClick={() => setCollapsed((c) => ({ ...c, [provider]: open }))}
                  >
                    {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                    {provider}
                    <span className="model-group-count">{list.length}</span>
                  </button>
                  {open && <ul role="presentation">{list.map((m) => renderOption(m))}</ul>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** Compact send-mode menu (spec T4): default Send stays visible, advanced modes stay reachable. */
function ModeMenu({ mode, running, onMode }: { mode: 'prompt' | 'steer' | 'followUp'; running: boolean; onMode(m: 'prompt' | 'steer' | 'followUp'): void }) {
  const [open, setOpen] = useState(false)
  const effectiveMode = running && mode === 'prompt' ? 'steer' : mode
  const options: readonly ('prompt' | 'steer' | 'followUp')[] = running ? ['steer', 'followUp'] : ['prompt', 'steer', 'followUp']
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const close = (): void => { setOpen(false); triggerRef.current?.focus() }

  useEffect(() => {
    if (!open) return
    const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    ;(selected ?? menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    if (items.length === 0) return
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next].focus()
    }
  }

  return (
    <div className="mode-menu">
      <button type="button" ref={triggerRef} aria-label={`Chế độ gửi: ${MODE_LABEL[effectiveMode]}`} aria-haspopup="menu" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}>
        {MODE_LABEL[effectiveMode]} <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div ref={menuRef} className="mode-popover" role="menu" aria-label="Chế độ gửi" onKeyDown={onMenuKeyDown}>
          {options.map((m) => (
            <button
              key={m}
              role="menuitemradio"
              aria-checked={effectiveMode === m}
              onClick={() => { onMode(m); close() }}
            >
              {MODE_LABEL[m]}{mode === m ? ' ✓' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ThinkingPicker({ level, levels, onSet, onError }: {
  level: string | null
  levels: string[]
  onSet(value: string): Promise<void>
  onError(message: string): void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const options = levels.length > 0 ? levels : ['off', 'minimal', 'low', 'medium', 'high']

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    ;(selected ?? menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
  }

  const pick = async (value: string): Promise<void> => {
    setOpen(false)
    triggerRef.current?.focus()
    try {
      await onSet(value)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="thinking-picker">
      <button ref={triggerRef} type="button" className="thinking-trigger" aria-label={`Thinking: ${level ?? 'mặc định'}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>Thinking{level ? ` · ${level}` : ''}</span><ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div ref={menuRef} className="thinking-popover" role="menu" aria-label="Mức thinking" onKeyDown={onMenuKeyDown}>
          {options.map((option) => (
            <button key={option} type="button" role="menuitemradio" aria-checked={level === option} onClick={() => void pick(option)}>
              {option}{level === option ? ' ✓' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Composer({
  sessionKey,
  running,
  queue,
  commands,
  context,
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
  models: ModelOption[]
  onSetModel(modelId: string): Promise<void>
  onSetThinking(level: string): Promise<void>
  actions: ComposerActions
}) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'prompt' | 'steer' | 'followUp'>('prompt')
  const [error, setError] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [mention, setMention] = useState<{ query: string; results: { path: string }[] } | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const queuedMessages = [...queue.steering, ...queue.followUp]
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const send = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) return
    const effectiveMode = running && mode === 'prompt' ? 'steer' : mode
    try {
      await actions.onSend(trimmed, effectiveMode, messageId())
      // Only clear the error on success — wiping it before the attempt makes the banner flash
      // and the layout jump every time the user re-presses Enter on a failing send.
      setError(null)
      setText('')
      setMode(running ? 'followUp' : 'prompt')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onTextChange = useCallback((value: string): void => {
    setText(value)
    // Typing always re-arms the slash picker (new token, selection reset).
    setSlashIndex(0)
    setSlashDismissed(false)
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
  }, [actions.onFileSearch])

  // Telegram-style quick typing: the keydown has already been dispatched by the time focus()
  // runs, so focusing alone loses the first character. Add that exact character to controlled
  // state here, then keep the cursor at the end so every subsequent key continues naturally.
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return

      const active = document.activeElement as HTMLElement | null
      if (active) {
        const tag = active.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable) return
        if (active.closest('.terminal-pane, .xterm, [role="dialog"], .dialog-overlay, .host-dialog')) return
        if (active.classList.contains('xterm-helper-textarea')) return
        if ((tag === 'button' || active.getAttribute('role') === 'button') && e.key === ' ') return
      }
      if (document.querySelector('[role="dialog"], .dialog-overlay, .host-dialog')) return

      const el = inputRef.current
      if (!el || document.activeElement === el) return
      e.preventDefault()
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
      onTextChange(`${text}${e.key}`)
    }

    window.addEventListener('keydown', onGlobalKeyDown)
    return () => window.removeEventListener('keydown', onGlobalKeyDown)
  }, [text, onTextChange])

  // The picker only lives while the draft is a single `/<token>` — once args are typed the
  // token is complete, so the popover closes and Enter sends instead of re-selecting.
  const slashToken = text.startsWith('/') && !/\s/.test(text) ? text.slice(1) : null
  const slashMatches = slashToken !== null && !slashDismissed
    ? commands.filter((c) => c.name.startsWith(slashToken)).slice(0, 8)
    : []
  const pickSlash = (index: number): void => {
    const match = slashMatches[Math.min(index, slashMatches.length - 1)]
    if (!match) return
    // The composer owns the single displayed slash; command names arrive slashless.
    setText(`/${match.name} `)
    inputRef.current?.focus()
  }

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
        }        void prepareAttachment(file)
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
      // Cancelling the native picker fires only 'cancel' (no change event) — without this
      // reset the attach button stays disabled for the rest of the session (owner UAT R3).
      input.oncancel = () => setAttaching(false)
      input.click()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setAttaching(false)
    }
  }

  const tokens = context?.tokens ?? 0
  const windowTokens = context?.window ?? 0
  const pct = windowTokens > 0 ? Math.round((tokens / windowTokens) * 100) : 0
  const nearWindowLimit = pct >= 80

  return (
    <section className="composer" aria-label="Composer">
      {slashMatches.length > 0 && (
        <ul className="slash-popover" role="listbox" aria-label="Slash commands">
          {slashMatches.map((c, i) => (
            <li key={`${c.category}:${c.name}`}>
              <button
                role="option"
                aria-selected={i === slashIndex}
                className={i === slashIndex ? 'active' : undefined}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => pickSlash(i)}
              >
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
      <div className="composer-shell">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (slashMatches.length > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return }
              if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // Enter over an open picker inserts the command; Enter with the picker
              // closed (no match, dismissed, or args typed) sends as before.
              if (slashMatches.length > 0) { pickSlash(slashIndex); return }
              void send()
            }
          }}
          placeholder={running ? 'Đang chạy — gửi steer/follow-up…' : 'Gõ tin nhắn, / lệnh, @file…'}
          aria-label="Tin nhắn"
        />
        <div className="composer-footer">
          <div className="composer-controls">
            <ModelPicker models={models} current={model} sessionKey={sessionKey} onSetModel={onSetModel} onError={setError} />
            <ThinkingPicker level={thinking} levels={thinkingLevels} onSet={onSetThinking} onError={setError} />
            <ModeMenu mode={mode} running={running} onMode={setMode} />
            <button className="attach-btn" type="button" onClick={() => void pickAttachment()} disabled={attaching} aria-busy={attaching} aria-label="Đính kèm tệp (prompt-only, tối đa 10 MiB)">
              <Paperclip size={16} aria-hidden="true" />{attaching && <span>…</span>}
            </button>
          </div>
          <div className="composer-actions">
            {queuedMessages.length > 0 && (
              <details className="composer-queue">
                <summary>Hàng đợi ({queuedMessages.length})</summary>
                <ul>{queuedMessages.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
                <button onClick={() => void actions.onDequeue().then((restored) => setText(restored.join('\n')))} title="Lấy nội dung khỏi hàng đợi">Lấy lại</button>
              </details>
            )}
            {nearWindowLimit && (
              <span className="composer-context-cue" role="status" title="Context sắp đầy — cân nhắc /compact">
                Context {pct}%
              </span>
            )}
            {running ? (
              <button className="danger" onClick={() => void actions.onAbort().then((result) => {
                if (result.wasRunning && !result.stopped) setError('Host chưa xác nhận đã dừng — lượt vẫn có thể đang chạy.')
              }).catch((e) => setError(e.message))}>Abort</button>
            ) : (
              <button className="primary send-btn" onClick={() => void send()} disabled={!text.trim()}><span>Gửi</span><ArrowUp size={16} aria-hidden="true" /></button>
            )}
          </div>
        </div>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
    </section>
  )
}
