import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ProjectInfo, SessionSummary } from '@shared/remote'
import { Ellipsis, Plus } from 'lucide-react'
import { useWorkbench } from './workbench-store'

/**
 * Session rail (spec T4 UX contract): host-scoped session list with search, rename/delete/clone
 * context menu, and subagent grouping (Agents view lives on the same rail). Panels collapse
 * without changing the semantic focus order.
 */

export type SessionRailActions = {
  onOpen(sessionKey: string): void
  onRename(sessionKey: string, title: string): Promise<void>
  onDelete(sessionKey: string): Promise<void>
  onClone(sessionKey: string): Promise<void>
  onCreate(projectId: string): Promise<void>
}

export function SessionRail({
  hostId,
  sessions,
  projects = [],
  selectedProjectId = null,
  onSelectProject = () => {},
  selectedSessionKey,
  actions,
  className = '',
  footer,
  mobileOpen = false,
}: {
  hostId: string
  sessions: SessionSummary[]
  projects?: ProjectInfo[]
  selectedProjectId?: string | null
  onSelectProject?(projectId: string | null): void
  selectedSessionKey: string | null
  actions: SessionRailActions
  className?: string
  footer?: ReactNode
  mobileOpen?: boolean
}) {
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renameFor, setRenameFor] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteFor, setDeleteFor] = useState<string | null>(null)
  const notice = useWorkbench((s) => s.notice)
  const setNotice = useWorkbench((s) => s.setNotice)

  const scopedSessions = useMemo(() => selectedProjectId ? sessions.filter((session) => session.projectId === selectedProjectId) : sessions, [sessions, selectedProjectId])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return scopedSessions
    return scopedSessions.filter((s) => s.title.toLowerCase().includes(q) || s.sessionKey.toLowerCase().includes(q) || (s.preview ?? '').toLowerCase().includes(q))
  }, [scopedSessions, query])


  const run = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (e) {
        setNotice('error', e instanceof Error ? e.message : String(e))
      }
    },
    [setNotice],
  )

  useEffect(() => {
    const close = () => setMenuFor(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const firstProjectId = selectedProjectId ?? sessions.find((session) => session.sessionKey === selectedSessionKey)?.projectId ?? projects[0]?.id ?? ''

  return (
    <nav id="session-rail" className={`session-rail ${className}`.trim()} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen || undefined} aria-label={`Sessions on ${hostId}`} tabIndex={mobileOpen ? -1 : undefined}>
      <div className="rail-search">
        {projects.length > 1 && (
          <select aria-label="Project" value={selectedProjectId ?? 'all'} onChange={(event) => onSelectProject(event.target.value === 'all' ? null : event.target.value)}>
            <option value="all">Tất cả project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tìm phiên…"
          aria-label="Tìm phiên hoặc tin nhắn đầu tiên"
        />
        <button className="new-session" aria-label="Tạo phiên mới" onClick={() => void run(() => actions.onCreate(firstProjectId))} title="Tạo phiên mới">
          <Plus size={18} aria-hidden="true" />
        </button>
      </div>
      {notice && (
        <p className={`notice ${notice.level === 'error' ? 'error' : ''}`} role="status">
          {notice.text}
        </p>
      )}
      <ul className="session-list">
        {filtered.length === 0 && <li className="empty">Chưa có phiên nào trên host này.</li>}
        {filtered.map((s) => (
          <li key={s.sessionKey} className={s.sessionKey === selectedSessionKey ? 'selected' : ''}>
            {renameFor === s.sessionKey ? (
              <form className="session-rename" onSubmit={(event) => { event.preventDefault(); if (renameValue.trim()) void run(() => actions.onRename(s.sessionKey, renameValue.trim())).then(() => setRenameFor(null)) }}>
                <input aria-label={`Tên mới cho ${s.title}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
                <button className="primary" disabled={!renameValue.trim()}>Lưu</button>
                <button type="button" onClick={() => setRenameFor(null)}>Huỷ</button>
              </form>
            ) : (
              <button
                className="session-row"
                onClick={() => actions.onOpen(s.sessionKey)}
                aria-current={s.sessionKey === selectedSessionKey ? 'true' : undefined}
              >
                <span className="session-title">{s.title || s.sessionKey}</span>
                {s.preview && <span className="session-preview">{s.preview}</span>}
                <span className="session-meta">
                  <small>{formatSessionTime(s.updatedAt)}</small>
                  {s.status === 'running' && <span className="live-dot" role="img" aria-label="Đang chạy" />}
                </span>
              </button>
            )}
            {renameFor !== s.sessionKey && <button
              className="session-menu"
              aria-label={`Tuỳ chọn phiên ${s.title}`}
              onClick={(e) => {
                e.stopPropagation()
                setMenuFor(menuFor === s.sessionKey ? null : s.sessionKey)
              }}
            >
              <Ellipsis size={16} aria-hidden="true" />
            </button>}
            {menuFor === s.sessionKey && (
              <div className="context-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                <button role="menuitem" onClick={() => { setRenameFor(s.sessionKey); setRenameValue(s.title); setMenuFor(null) }}>Đổi tên</button>
                <button role="menuitem" onClick={() => { void run(() => actions.onClone(s.sessionKey)); setMenuFor(null) }}>Nhân bản</button>
                <button role="menuitem" className="danger-text" onClick={() => { setDeleteFor(s.sessionKey); setMenuFor(null) }}>Xoá</button>
              </div>
            )}
            {deleteFor === s.sessionKey && (
              <div className="session-delete-confirm" role="alertdialog">
                <span>Xoá phiên này?</span>
                <button className="danger" onClick={() => void run(() => actions.onDelete(s.sessionKey)).then(() => setDeleteFor(null))}>Xoá</button>
                <button onClick={() => setDeleteFor(null)}>Huỷ</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {footer && <div className="rail-footer">{footer}</div>}
    </nav>
  )
}

function formatSessionTime(updatedAt: number): string {
  const date = new Date(updatedAt)
  if (!Number.isFinite(date.getTime())) return ''
  const elapsedMs = Date.now() - date.getTime()
  if (elapsedMs < 60_000) return 'vừa xong'
  if (elapsedMs < 60 * 60_000) return `${Math.floor(elapsedMs / 60_000)} phút`
  if (date.toDateString() === new Date().toDateString()) {
    return `Hôm nay, ${date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`
  }
  return date.toLocaleDateString('vi-VN', { day: 'numeric', month: 'short' })
}
