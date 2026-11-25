import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, Ellipsis, File, Folder, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { ContextStats, SessionUsage, BranchInfo, Turn, DiffLine } from '@shared/remote'
import type { HostConnection } from '../transport/host-connection'
import { createTerminalWriter } from '../features/terminal'
import { timelineToMarkdown, timelineToHtmlBody } from './export-session'
import { sanitizeExportDocument } from '../features/markdown'
import { AgentsPanel } from './AgentsPanel'
import { agentRunsFromTurns } from './agent-runs'

/**
 * Inspector (spec T4 UX contract): Review/Files/Context/Tree/Terminal tabs. Terminal uses
 * xterm.js with OSC 52 clipboard write stripped from the host stream (T4 acceptance).
 * Panels collapse without changing semantic focus order.
 */

export type InspectorTab = 'review' | 'files' | 'context' | 'tree' | 'agents' | 'terminal' | 'settings'

/** Terminal palette follows the app theme (spec T4): light = white/black, dark = dark surface. */
export const TERMINAL_THEMES = {
  light: {
    background: '#ffffff', foreground: '#111111', cursor: '#111111', cursorAccent: '#ffffff', selectionBackground: '#d9dce3',
    black: '#111111', red: '#d1242f', green: '#1a7f37', yellow: '#9a6700', blue: '#0550ae', magenta: '#8250df', cyan: '#1b7c83', white: '#57606a',
    brightBlack: '#57606a', brightRed: '#cf222e', brightGreen: '#116329', brightYellow: '#4d2d00', brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#1b7c83', brightWhite: '#24292f',
  },
  dark: {
    background: '#1f1f1f', foreground: '#cccccc', cursor: '#cccccc', cursorAccent: '#1f1f1f', selectionBackground: '#313338',
    black: '#3a3a3d', red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d4d4d4',
    brightBlack: '#6e7681', brightRed: '#f85149', brightGreen: '#3fb950', brightYellow: '#d29922', brightBlue: '#58a6ff', brightMagenta: '#bc8cff', brightCyan: '#39c5cf', brightWhite: '#e6e6e6',
  },
} as const

function appThemeIsDark(): boolean {
  return resolveTerminalTheme() === 'dark'
}

/**
 * Theme source of truth: the device-local `lix-web-ui` preference (same key the anti-FOUC
 * bootstrap reads), falling back to the `dark` class, then the OS preference. Owner UAT R3:
 * the terminal must match the app theme — dark app ⇒ dark terminal, light app ⇒ light terminal.
 */
export function resolveTerminalTheme(): 'light' | 'dark' {
  try {
    const raw = localStorage.getItem('lix-web-ui')
    const theme = raw ? ((JSON.parse(raw).state ?? {}) as { theme?: unknown }).theme : null
    if (theme === 'light' || theme === 'dark') return theme
  } catch { /* first run */ }
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) return 'dark'
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export type InspectorProps = {
  sessionKey: string
  tab: InspectorTab
  onTab(tab: InspectorTab): void
  reviewDiff: { isRepo: boolean; branch?: string; files: { path: string; add: number; del: number; status: string }[]; file?: { path: string; lines: DiffLine[]; truncated: boolean }; message?: string } | null
  onLoadDiff(scope: 'git' | 'turn', path?: string): Promise<void>
  files: { path: string; kind: string }[]
  onListFiles(path: string): Promise<void>
  onReadFile(path: string): Promise<string>
  onCreateFile(path: string, dir: boolean): Promise<void>
  onRenameFile(path: string, newName: string): Promise<void>
  stats: { context: ContextStats | null; usage: SessionUsage | null } | null
  branches: BranchInfo[]
  onSwitchBranch(leafId: string): Promise<void>
  onAgentSteer(text: string): Promise<void>
  onAgentAbort(): Promise<void>
  onAgentResume(context: string): Promise<void>
  conn: HostConnection | null
  onExport(format: 'markdown' | 'html'): void
  timelineTurns: Turn[]
  sessionTitle: string
  /** Host & session settings (moved out of the workbench footer by owner UAT 2026-11-24). */
  settingsPanel?: ReactNode
  modal?: boolean
}

/** Terminal view: opens a PTY, pipes output through the OSC 52 filter, input goes to the host. */
export function TerminalPane({ sessionKey, conn }: { sessionKey: string; conn: InspectorProps['conn'] }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'closed' | 'opening' | 'open' | 'exited'>('closed')
  // xterm is loaded lazily: the TerminalView mounts only when the tab opens.
  useEffect(() => {
    if (!conn) return
    let disposed = false
    let termHandle: { write(s: string): void; dispose(): void } | null = null
    let terminalId: string | null = null
    const earlyOutput = new Map<string, string[]>()
    let eventCleanup = () => {}
    let resizeSubscription: { dispose(): void } | null = null
    let themeObserver: MutationObserver | null = null

    void (async () => {
      try {
        setStatus('opening')
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
        const term = new Terminal({ convertEol: true, cursorBlink: false, allowProposedApi: false, theme: TERMINAL_THEMES[resolveTerminalTheme()] })
        // Follow live theme flips (topbar toggle): repaint the palette without re-opening the PTY.
        themeObserver = typeof MutationObserver !== 'undefined'
          ? new MutationObserver(() => { term.options.theme = TERMINAL_THEMES[resolveTerminalTheme()] })
          : null
        themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
        const fit = new FitAddon()
        term.loadAddon(fit)
        if (disposed || !hostRef.current) return
        term.open(hostRef.current)
        fit.fit()
        termHandle = term
        // OSC 52 (clipboard write) never reaches xterm — spec T4 acceptance.
        const write = createTerminalWriter((s) => term.write(s))
        eventCleanup = conn.subscribeEvents((event, payload) => {
          if (event === 'terminal.data') {
            const data = payload as import('@shared/remote').EventPayload<'terminal.data'>
            if (terminalId === data.terminalId) write(data.data)
            else {
              const pending = earlyOutput.get(data.terminalId) ?? []
              pending.push(data.data)
              earlyOutput.set(data.terminalId, pending)
            }
          } else if (event === 'terminal.exit') {
            const exited = payload as import('@shared/remote').EventPayload<'terminal.exit'>
            if (terminalId === exited.terminalId) setStatus('exited')
          }
        })

        const opened = await conn.request('terminal.open', { sessionKey, cols: term.cols, rows: term.rows })
        if (disposed) return
        terminalId = opened.terminalId
        setStatus('open')
        for (const chunk of earlyOutput.get(terminalId) ?? []) write(chunk)
        earlyOutput.delete(terminalId)

        term.onData((data) => {
          if (terminalId && !disposed) void conn.request('terminal.input', { terminalId, data }).catch(() => undefined)
        })
        resizeSubscription = term.onResize(({ cols, rows }) => {
          if (terminalId && !disposed) void conn.request('terminal.resize', { terminalId, cols, rows }).catch(() => undefined)
        })
      } catch (e) {
        if (!disposed) {
          setStatus('exited')
          if (hostRef.current) hostRef.current.textContent = `Không mở được terminal: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    })()

    return () => {
      disposed = true
      themeObserver?.disconnect()
      eventCleanup()
      resizeSubscription?.dispose()
      if (terminalId && conn.online) void conn.request('terminal.close', { terminalId }).catch(() => undefined)
      termHandle?.dispose()
    }
  }, [conn, sessionKey])

  return (
    <div className="terminal-pane">
      <div ref={hostRef} className="terminal-host" data-status={status} />
      {status === 'exited' && <p className="notice">Terminal đã kết thúc.</p>}
    </div>
  )
}

export function Inspector(props: InspectorProps) {
  const { sessionKey, tab, reviewDiff, onLoadDiff, files, onListFiles, onReadFile, onCreateFile, onRenameFile, stats, branches, onSwitchBranch, onAgentSteer, onAgentAbort, onAgentResume, conn, onExport, timelineTurns, sessionTitle } = props
  const [filePreview, setFilePreview] = useState<{ path: string; content: string } | null>(null)
  const [reviewScope, setReviewScope] = useState<'git' | 'turn'>('turn')
  const [currentDirectory, setCurrentDirectory] = useState('.')
  const [newPath, setNewPath] = useState('')
  const [newIsDirectory, setNewIsDirectory] = useState(false)
  const [renamePath, setRenamePath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const fileMenuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const fileActionMenuRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const exportTriggerRef = useRef<HTMLButtonElement | null>(null)
  const exportMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    setCurrentDirectory('.')
    setFilePreview(null)
    setRenamePath(null)
    setNewPath('')
  }, [sessionKey])

  useEffect(() => {
    if (!menuFor) return
    const close = () => setMenuFor(null)
    window.addEventListener('click', close)
    fileActionMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => window.removeEventListener('click', close)
  }, [menuFor])

  useEffect(() => {
    if (renamePath) renameInputRef.current?.focus()
  }, [renamePath])

  useEffect(() => {
    if (!exportMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !exportMenuRef.current?.contains(event.target) && !exportTriggerRef.current?.contains(event.target)) setExportMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setExportMenuOpen(false)
      exportTriggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    exportMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [exportMenuOpen])

  return (
    <aside id="workbench-inspector" className="inspector" role={props.modal ? 'dialog' : undefined} aria-modal={props.modal || undefined} aria-labelledby="inspector-title" tabIndex={props.modal ? -1 : undefined}>
      <header className="inspector-head">
        <h2 id="inspector-title">Terminal</h2>
        <div className="export-wrap">
          <button ref={exportTriggerRef} className="export-trigger" aria-label="Xuất phiên" aria-haspopup="menu" aria-expanded={exportMenuOpen} onClick={() => setExportMenuOpen((open) => !open)}>
            <Ellipsis size={18} aria-hidden="true" />
          </button>
          {exportMenuOpen && (
            <div
              ref={exportMenuRef}
              className="small-menu export-menu"
              role="menu"
              aria-label="Xuất phiên"
              onKeyDown={(event) => {
                const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
                if (!items.length) return
                const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                  items[next].focus()
                }
              }}
            >
              <button type="button" role="menuitem" onClick={() => { onExport('markdown'); setExportMenuOpen(false); exportTriggerRef.current?.focus() }}>
                <Download size={15} aria-hidden="true" /> Xuất Markdown
              </button>
              <button type="button" role="menuitem" onClick={() => { onExport('html'); setExportMenuOpen(false); exportTriggerRef.current?.focus() }}>
                <Download size={15} aria-hidden="true" /> Xuất HTML
              </button>
            </div>
          )}
        </div>
      </header>
      <div id="inspector-panel" className="inspector-body" aria-label={tab === 'terminal' ? 'Terminal' : undefined}>
        {tab === 'review' && (
          <div className="review-panel">
            <div className="review-scope">
              <button aria-pressed={reviewScope === 'turn'} onClick={() => { setReviewScope('turn'); void onLoadDiff('turn') }}>Diff lượt</button>
              <button aria-pressed={reviewScope === 'git'} onClick={() => { setReviewScope('git'); void onLoadDiff('git') }}>Diff Git</button>
            </div>
            {!reviewDiff && <div className="empty">Chọn scope để xem diff.</div>}
            {reviewDiff && !reviewDiff.isRepo && <div className="empty">Thư mục không phải Git repo.</div>}
            {reviewDiff?.isRepo && (
              <ul className="diff-files">
                {reviewDiff.branch && <li className="muted">branch: {reviewDiff.branch}</li>}
                {reviewDiff.files.map((f) => (
                  <li key={f.path}>
                    <button className="diff-file" onClick={() => void onLoadDiff(reviewScope, f.path)}>
                      <code>{f.path}</code> <span className="added">+{f.add}</span> <span className="removed">−{f.del}</span> <span className="muted">{f.status}</span>
                    </button>
                  </li>
                ))}
                {reviewDiff.files.length === 0 && <li className="empty">Không có thay đổi.</li>}
              </ul>
            )}
            {reviewDiff?.file && (
              <div className="diff-view" aria-label={`Diff ${reviewDiff.file.path}`}>
                <h4>{reviewDiff.file.path}{reviewDiff.file.truncated ? ' (truncated)' : ''}</h4>
                <pre>{reviewDiff.file.lines.map((line, index) => <div key={`${line.k}:${index}`} className={`diff-line ${line.k}`}><span className="diff-number">{line.o ?? line.n ?? ''}</span><code>{line.s}</code></div>)}</pre>
              </div>
            )}
          </div>
        )}
        {tab === 'files' && (
          <div className="files-panel">
            <div className="files-location">
              <span>{currentDirectory}</span>
              {currentDirectory !== '.' && <button onClick={() => { const parent = currentDirectory.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.'; setCurrentDirectory(parent); void onListFiles(parent) }}>Lên một cấp</button>}
            </div>
            <form className="file-create" onSubmit={(event) => { event.preventDefault(); if (newPath.trim()) { const path = currentDirectory === '.' ? newPath.trim() : `${currentDirectory}/${newPath.trim()}`; void onCreateFile(path, newIsDirectory).then(() => setNewPath('')) } }}>
              <input aria-label="Tên file hoặc thư mục mới" value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="Tạo file/thư mục…" />
              <label><input type="checkbox" checked={newIsDirectory} onChange={(event) => setNewIsDirectory(event.target.checked)} /> Thư mục</label>
              <button className="primary" disabled={!newPath.trim()}>Tạo</button>
            </form>
            <ul>
              {files.map((f) => (
                <li key={f.path} className="file-row">
                  <button className="file-open" onClick={() => {
                    if (f.kind === 'dir') {
                      setCurrentDirectory(f.path)
                      setFilePreview(null)
                      void onListFiles(f.path)
                    } else {
                      void onReadFile(f.path).then((content) => setFilePreview({ path: f.path, content })).catch(() => setFilePreview({ path: f.path, content: '(không đọc được)' }))
                    }
                  }}>
                    {f.kind === 'dir' ? <Folder size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}
                    <span>{f.path}</span>
                  </button>
                  <button className="file-menu-trigger" aria-label={`Tuỳ chọn ${f.path}`} aria-haspopup="menu" aria-expanded={menuFor === f.path} onClick={(event) => { event.stopPropagation(); fileMenuTriggerRef.current = event.currentTarget; setMenuFor(menuFor === f.path ? null : f.path) }}><Ellipsis size={17} aria-hidden="true" /></button>
                  {menuFor === f.path && (
                    <div
                      ref={fileActionMenuRef}
                      className="context-menu file-action-menu"
                      role="menu"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          setMenuFor(null)
                          fileMenuTriggerRef.current?.focus()
                        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                          event.preventDefault()
                          fileActionMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
                        }
                      }}
                    >
                      <button role="menuitem" onClick={() => { setRenamePath(f.path); setRenameValue(f.path.split(/[\\/]/).pop() ?? f.path); setMenuFor(null) }}>Đổi tên</button>
                    </div>
                  )}
                  {renamePath === f.path && (
                    <form onSubmit={(event) => { event.preventDefault(); if (renameValue.trim()) void onRenameFile(f.path, renameValue.trim()).then(() => setRenamePath(null)) }}>
                      <input ref={renameInputRef} aria-label={`Tên mới cho ${f.path}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
                      <button className="primary" disabled={!renameValue.trim()}>Lưu</button>
                      <button type="button" onClick={() => setRenamePath(null)}>Huỷ</button>
                    </form>
                  )}
                </li>
              ))}
              {files.length === 0 && <li className="empty">Trống.</li>}
            </ul>
            {filePreview && (
              <div className="file-preview-wrap">
                <div className="file-preview-head">
                  <span className="file-preview-path">{filePreview.path}</span>
                  <button aria-label="Đóng xem trước" onClick={() => setFilePreview(null)}><X size={15} aria-hidden="true" /></button>
                </div>
                <pre className="file-preview">
                  {filePreview.content.length > 20000 ? filePreview.content.slice(0, 20000) + '\n… (truncated)' : filePreview.content}
                </pre>
              </div>
            )}
          </div>
        )}
        {tab === 'context' && (
          <div className="context-panel">
            {stats?.context ? (
              <>
                <p>{stats.context.tokens.toLocaleString()} / {stats.context.window?.toLocaleString() ?? '?'} tokens</p>
                <ul>
                  {stats.context.breakdown.map((b) => (
                    <li key={b.role}>{b.role}: {b.tokens.toLocaleString()}</li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="empty">Chưa có số liệu context.</div>
            )}
            {stats?.usage && (
              <p className="muted">
                cost ${stats.usage.cost.toFixed(4)} · in {stats.usage.input.toLocaleString()} · out {stats.usage.output.toLocaleString()} · {stats.usage.calls} calls
              </p>
            )}
          </div>
        )}
        {tab === 'tree' && (
          <div className="tree-panel">
            <ul role="list" aria-label="Branches">
              {branches.map((b) => (
                <li key={b.leafId} className={b.current ? 'current' : ''}>
                  <button onClick={() => void onSwitchBranch(b.leafId)}>
                    {b.current ? '● ' : '○ '}
                    {b.title} <span className="muted">({b.turns} lượt)</span>
                  </button>
                </li>
              ))}
              {branches.length === 0 && <li className="empty">Chưa có nhánh nào khác.</li>}
            </ul>
          </div>
        )}
        {tab === 'agents' && (
          <AgentsPanel
            runs={agentRunsFromTurns(timelineTurns, sessionKey)}
            onLoadDetail={async (toolCallId) => {
              if (!conn) return ''
              const result = await conn.request('turn.toolDetail', { sessionKey, toolCallId })
              return result.output ?? result.node.preview ?? result.node.fallbackText
            }}
            onSteer={onAgentSteer}
            onAbort={onAgentAbort}
            onResume={onAgentResume}
          />
        )}
        {tab === 'terminal' && <TerminalPane sessionKey={sessionKey} conn={conn} />}
        {tab === 'settings' && props.settingsPanel}
      </div>
    </aside>
  )
}

/** Export helpers (download through a blob URL — stays local to the browser). */
export function downloadExport(format: 'markdown' | 'html', sessionTitle: string, turns: Turn[]): void {
  const base = sessionTitle.replace(/[^\w\-]+/g, '-').slice(0, 60) || 'session'
  if (format === 'markdown') {
    const blob = new Blob([timelineToMarkdown(sessionTitle, turns)], { type: 'text/markdown' })
    triggerDownload(blob, `${base}.md`)
    return
  }
  const doc = sanitizeExportDocument(sessionTitle, timelineToHtmlBody(turns))
  triggerDownload(new Blob([doc], { type: 'text/html' }), `${base}.html`)
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
