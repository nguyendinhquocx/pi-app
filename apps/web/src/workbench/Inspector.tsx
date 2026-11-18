import { useEffect, useRef, useState } from 'react'
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

export type InspectorTab = 'review' | 'files' | 'context' | 'tree' | 'agents' | 'terminal'

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

    void (async () => {
      try {
        setStatus('opening')
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
        const term = new Terminal({ convertEol: true, cursorBlink: false, allowProposedApi: false })
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
  const { sessionKey, tab, onTab, reviewDiff, onLoadDiff, files, onListFiles, onReadFile, onCreateFile, onRenameFile, stats, branches, onSwitchBranch, onAgentSteer, onAgentAbort, onAgentResume, conn, onExport, timelineTurns, sessionTitle } = props
  const [filePreview, setFilePreview] = useState<{ path: string; content: string } | null>(null)
  const [reviewScope, setReviewScope] = useState<'git' | 'turn'>('turn')
  const [currentDirectory, setCurrentDirectory] = useState('.')
  const [newPath, setNewPath] = useState('')
  const [newIsDirectory, setNewIsDirectory] = useState(false)
  const [renamePath, setRenamePath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const tabs: InspectorTab[] = ['review', 'files', 'context', 'tree', 'agents', 'terminal']

  useEffect(() => {
    setCurrentDirectory('.')
    setFilePreview(null)
    setRenamePath(null)
    setNewPath('')
  }, [sessionKey])

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => onTab(t)}>
            {t === 'review' ? 'Review' : t === 'files' ? 'Files' : t === 'context' ? 'Context' : t === 'tree' ? 'Tree' : t === 'agents' ? 'Agents' : 'Terminal'}
          </button>
        ))}
        <button className="export-btn" aria-label="Export phiên (Markdown)" onClick={() => onExport('markdown')}>MD↓</button>
        <button className="export-btn" aria-label="Export phiên (HTML)" onClick={() => onExport('html')}>HTML↓</button>
      </div>
      <div className="inspector-body">
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
                  <button onClick={() => {
                    if (f.kind === 'dir') {
                      setCurrentDirectory(f.path)
                      setFilePreview(null)
                      void onListFiles(f.path)
                    } else {
                      void onReadFile(f.path).then((content) => setFilePreview({ path: f.path, content })).catch(() => setFilePreview({ path: f.path, content: '(không đọc được)' }))
                    }
                  }}>
                    {f.kind === 'dir' ? '📁' : '📄'} {f.path}
                  </button>
                  <button onClick={() => { setRenamePath(f.path); setRenameValue(f.path.split(/[\\/]/).pop() ?? f.path) }}>Đổi tên</button>
                  {renamePath === f.path && (
                    <form onSubmit={(event) => { event.preventDefault(); if (renameValue.trim()) void onRenameFile(f.path, renameValue.trim()).then(() => setRenamePath(null)) }}>
                      <input aria-label={`Tên mới cho ${f.path}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
                      <button className="primary" disabled={!renameValue.trim()}>Lưu</button>
                      <button type="button" onClick={() => setRenamePath(null)}>Huỷ</button>
                    </form>
                  )}
                </li>
              ))}
              {files.length === 0 && <li className="empty">Trống.</li>}
            </ul>
            {filePreview && (
              <pre className="file-preview">
                {filePreview.content.length > 20000 ? filePreview.content.slice(0, 20000) + '\n… (truncated)' : filePreview.content}
              </pre>
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
