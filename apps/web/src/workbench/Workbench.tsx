import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { CommandInfo, BranchInfo, ContextStats, SessionUsage, MethodResult } from '@shared/remote'
import { useWorkbench, activeSlice, activeTimeline, connectStore } from './workbench-store'
import { openSessionInStore } from './workbench-store'
import { fetchOlderPageIfCurrent } from './timeline-store'
import type { HostConnection } from '../transport/host-connection'
import { rpc } from './workbench-store'
import { SessionRail, type SessionRailActions } from './SessionRail'
import { Timeline } from './Timeline'
import { Composer, type ComposerActions } from './Composer'
import { Inspector, downloadExport, type InspectorTab } from './Inspector'
import { ExtensionDialogs } from './ExtensionDialogs'
import { SettingsPanel, loadSettings, type SettingsData } from './SettingsPanel'
import type { PreparedAttachment } from '../features/upload'
import { Menu, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'

/**
 * Workbench shell (spec T4 UX contract): host rail → session rail → timeline/composer →
 * inspector. States surface in-place (banner, rail notices, stream indicator) — no modal ever
 * hides a running task or claims a false stop.
 */

export type WorkbenchConnection = { hostId: string; conn: HostConnection }

const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]):not([tabindex="-1"]),input:not([disabled]):not([tabindex="-1"]),select:not([disabled]):not([tabindex="-1"]),textarea:not([disabled]):not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])'

function trapTabKey(event: KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  if (focusable.length === 0) {
    event.preventDefault()
    return
  }
  const activeIndex = focusable.indexOf(document.activeElement as HTMLElement)
  if (activeIndex === -1) {
    event.preventDefault()
    ;(event.shiftKey ? focusable[focusable.length - 1] : focusable[0])?.focus()
  } else if (event.shiftKey && activeIndex === 0) {
    event.preventDefault()
    focusable[focusable.length - 1].focus()
  } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
    event.preventDefault()
    focusable[0].focus()
  }
}

export function Workbench({ connections, hostPicker }: { connections: WorkbenchConnection[]; hostPicker?: ReactNode }) {
  const slices = useWorkbench((s) => s.slices)
  const activeHostId = useWorkbench((s) => s.activeHostId)
  const setActiveHost = useWorkbench((s) => s.setActiveHost)
  const setSessions = useWorkbench((s) => s.setSessions)
  const notice = useWorkbench((s) => s.notice)

  const [settings, setSettings] = useState<Record<string, SettingsData>>({})
  const [hostStatuses, setHostStatuses] = useState<Record<string, { appVersion: string; sdkVersion: string }>>({})
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('terminal')
  const [reviewDiff, setReviewDiff] = useState<MethodResult<'review.diff'> | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [files, setFiles] = useState<{ path: string; kind: string }[]>([])
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [models, setModels] = useState<{ id: string; name: string; provider?: string; group?: string }[]>([])
  const [sessionMeta, setSessionMeta] = useState<{ model: string | null; thinking: string | null; thinkingLevels: string[]; context: ContextStats | null; usage: SessionUsage | null }>({ model: null, thinking: null, thinkingLevels: [], context: null, usage: null })
  const [mobileSessionListOpen, setMobileSessionListOpen] = useState(false)
  const [layout, setLayout] = useState<WorkbenchLayout>(loadLayout)
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth)
  const layoutWidths = useMemo(() => resolveWorkbenchWidths(layout, viewportWidth), [layout, viewportWidth])
  const inspectorIsModal = viewportWidth <= MOBILE_BREAKPOINT || (viewportWidth < TABLET_WIDE_BREAKPOINT && layout.railOpen)
  const mobileToggleRef = useRef<HTMLButtonElement | null>(null)
  const inspectorToggleRef = useRef<HTMLButtonElement | null>(null)
  const historyGeneration = useRef(0)
  const wiredHosts = useRef(new Set<string>())
  const hostStatusLoading = useRef(new Set<string>())

  const active = activeHostId ? connections.find((c) => c.hostId === activeHostId) ?? null : null
  const slice = activeSlice(useWorkbench.getState()) ?? (activeHostId ? slices[activeHostId] ?? null : null)
  const timeline = activeTimeline(useWorkbench.getState())
  const sessionKey = slice?.selectedSessionKey ?? null
  const selectedSummary = useMemo(
    () => slice?.sessions.find((s) => s.sessionKey === sessionKey) ?? null,
    [slice, sessionKey],
  )

  useEffect(() => {
    // These details belong to one host/session; never let a fast host switch flash stale
    // model, usage, branch, review or command data from the previous namespace.
    setSessionMeta({ model: null, thinking: null, thinkingLevels: [], context: null, usage: null })
    setBranches([])
    setCommands([])
    setModels([])
    setReviewDiff(null)
  }, [activeHostId, sessionKey])

  // Layout preference is device-local only (spec T2): widths/collapse never reach the host.
  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* private mode */ }
  }, [layout])

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewportWidth)
    return () => window.removeEventListener('resize', updateViewportWidth)
  }, [])

  // Host switch invalidates all outstanding history page requests, even if the user switches
  // away and back to the same session before the old RPC response arrives.
  useEffect(() => { historyGeneration.current += 1 }, [activeHostId])

  useEffect(() => {
    if (viewportWidth > MOBILE_BREAKPOINT) setMobileSessionListOpen(false)
  }, [viewportWidth])

  // Mobile session drawer: trap focus while modal; Escape, scrim and focus return all work.
  useEffect(() => {
    if (!mobileSessionListOpen || viewportWidth > MOBILE_BREAKPOINT) return
    const rail = document.getElementById('session-rail')
    rail?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileSessionListOpen(false)
      } else {
        trapTabKey(event, rail)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (window.innerWidth <= MOBILE_BREAKPOINT) mobileToggleRef.current?.focus()
    }
  }, [mobileSessionListOpen, viewportWidth])

  // Inspector becomes a modal sheet/overlay only where the CSS overlays the center pane.
  useEffect(() => {
    if (!layout.inspectorOpen) return
    const panel = document.getElementById('workbench-inspector')
    if (inspectorIsModal) panel?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setLayout((current) => ({ ...current, inspectorOpen: false }))
      } else if (inspectorIsModal) {
        trapTabKey(event, panel)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      inspectorToggleRef.current?.focus()
    }
  }, [layout.inspectorOpen, inspectorIsModal])

  // Wire each live host once; listeners stay host-scoped so session paths never merge.
  useEffect(() => {
    for (const item of connections) {
      if (wiredHosts.current.has(item.hostId)) continue
      connectStore(item.conn, item.hostId)
      useWorkbench.getState().setConnState(item.hostId, item.conn.state, item.conn.errorDetail)
      if (item.conn.hello) useWorkbench.getState().setSessionInfo(item.hostId, { role: item.conn.hello.role, ownerProtocol: item.conn.hello.ownerProtocol ?? null })
      wiredHosts.current.add(item.hostId)
    }
    for (const hostId of [...wiredHosts.current]) {
      if (!connections.some((item) => item.hostId === hostId)) {
        useWorkbench.getState().resetHost(hostId)
        wiredHosts.current.delete(hostId)
      }
    }
  }, [connections])

  // Auto-select the first connected host when none is active.
  useEffect(() => {
    if (!activeHostId && connections.length > 0) setActiveHost(connections[0].hostId)
  }, [activeHostId, connections, setActiveHost])

  const refreshSessionContext = useCallback(
    async (conn: HostConnection, sk: string) => {
      try {
        const stats = await rpc(conn, 'session.stats', { sessionKey: sk })
        const cmds = await rpc(conn, 'command.list', { sessionKey: sk })
        const modelsResult = await rpc(conn, 'model.list', { sessionKey: sk })
        setSessionMeta((m) => ({
          ...m,
          context: stats.context,
          usage: stats.usage ?? null,
          model: modelsResult.current ?? m.model,
          thinking: modelsResult.thinking ?? m.thinking,
          thinkingLevels: modelsResult.availableThinking,
        }))
        setCommands(cmds.commands)
        setModels(modelsResult.models.map((m) => ({ id: m.id, name: m.name ?? m.id, provider: m.provider, group: m.group })))
        const branchesResult = await rpc(conn, 'session.branches', { sessionKey: sk })
        setBranches(branchesResult.branches)
      } catch {
        /* per-section failures stay empty — the rail shows the error banner */
      }
    },
    [],
  )

  const openSession = useCallback(
    async (conn: HostConnection, hostId: string, sk: string) => {
      // Reopening the same session can restore the same first anchor; use a generation token so
      // page responses from the previous open still cannot append after that reopen.
      historyGeneration.current += 1
      const previous = useWorkbench.getState().slices[hostId]?.selectedSessionKey
      if (previous && previous !== sk) void conn.closeSession(previous).catch(() => undefined)
      useWorkbench.getState().selectSession(hostId, sk)
      try {
        const session = useWorkbench.getState().slices[hostId]?.sessions.find((item) => item.sessionKey === sk)
        if (session) useWorkbench.getState().selectProject(hostId, session.projectId)
        await openSessionInStore(conn, hostId, sk)
        await refreshSessionContext(conn, sk)
      } catch (e) {
        useWorkbench.getState().setNotice('error', e instanceof Error ? e.message : String(e))
      }
    },
    [refreshSessionContext],
  )

  const refreshSessions = useCallback(
    async (conn: HostConnection) => {
      try {
        // One unfiltered watch registers every allowed project. Repeated project-specific
        // watchList calls replace the host's watcher scope and silently leave only the last one.
        const [projectResult, watched] = await Promise.all([
          rpc(conn, 'project.list', {}),
          rpc(conn, 'session.watchList', {}),
        ])
        useWorkbench.getState().setProjects(conn.hostId, projectResult.projects)
        setSessions(conn.hostId, watched.sessions)
      } catch (e) {
        useWorkbench.getState().setNotice('error', e instanceof Error ? e.message : String(e))
      }
    },
    [setSessions],
  )

  const activeConnState = activeHostId ? slices[activeHostId]?.state : null
  useEffect(() => {
    if (!active || activeConnState !== 'online') return
    void refreshSessions(active.conn).catch(() => undefined)
  }, [active, activeConnState, refreshSessions])

  useEffect(() => {
    for (const item of connections) {
      if (!item.conn.online || hostStatuses[item.hostId] || hostStatusLoading.current.has(item.hostId)) continue
      hostStatusLoading.current.add(item.hostId)
      void rpc(item.conn, 'host.status', {}).then((status) => {
        setHostStatuses((current) => ({ ...current, [item.hostId]: { appVersion: status.appVersion, sdkVersion: status.sdkVersion } }))
      }).catch(() => undefined).finally(() => hostStatusLoading.current.delete(item.hostId))
    }
  }, [connections, hostStatuses, slices])

  const refreshFiles = useCallback(async (conn: HostConnection, sk: string, path = '.') => {
    const result = await rpc(conn, 'file.list', { sessionKey: sk, path })
    setFiles(result.entries.map((entry) => ({ path: entry.path, kind: entry.dir ? 'dir' : 'file' })))
  }, [])

  useEffect(() => {
    if (!active || !sessionKey) {
      setFiles([])
      return
    }
    void refreshFiles(active.conn, sessionKey).catch(() => setFiles([]))
  }, [active, sessionKey, refreshFiles])

  const railActions: SessionRailActions = useMemo(
    () => ({
      onOpen: (sk) => {
        if (active) void openSession(active.conn, active.hostId, sk)
      },
      onRename: async (sk, title) => {
        if (!active) return
        await rpc(active.conn, 'session.rename', { sessionKey: sk, title })
        await refreshSessions(active.conn)
      },
      onDelete: async (sk) => {
        if (!active) return
        await rpc(active.conn, 'session.delete', { sessionKey: sk })
        if (sessionKey === sk) useWorkbench.getState().selectSession(active.hostId, null)
        await refreshSessions(active.conn)
      },
      onClone: async (sk) => {
        if (!active) return
        const r = await rpc(active.conn, 'session.clone', { sessionKey: sk })
        await refreshSessions(active.conn)
        await openSession(active.conn, active.hostId, r.sessionKey)
      },
      onCreate: async (projectId) => {
        if (!active) return
        const projects = await rpc(active.conn, 'project.list', {})
        const project = projects.projects.find((item) => item.id === projectId) ?? projects.projects[0]
        if (!project) throw new Error('Host không có project khả dụng để tạo phiên.')
        const r = await rpc(active.conn, 'session.create', { projectId: project.id })
        await refreshSessions(active.conn)
        await openSession(active.conn, active.hostId, r.sessionKey)
      },
    }),
    [active, openSession, refreshSessions, sessionKey],
  )

  const timelineActions = useMemo(
    () => ({
      onRewind: async (sk: string, anchor: string) => {
        if (!active) return
        await rpc(active.conn, 'turn.rewind', { sessionKey: sk, anchor })
        await openSession(active.conn, active.hostId, sk)
      },
      onFork: async (sk: string, anchor: string) => {
        if (!active) return
        const r = await rpc(active.conn, 'session.fork', { sessionKey: sk, anchor })
        await refreshSessions(active.conn)
        await openSession(active.conn, active.hostId, r.sessionKey)
      },
      onToolDetail: async (sk: string, toolCallId: string) => {
        if (!active) return ''
        const r = await rpc(active.conn, 'turn.toolDetail', { sessionKey: sk, toolCallId })
        return r.output ?? (r.node.preview ?? r.node.fallbackText)
      },
    }),
    [active, openSession, refreshSessions],
  )

  const composerActions: ComposerActions = useMemo(
    () => ({
      onSend: async (text, mode, clientMessageId) => {
        if (!active || !sessionKey) throw new Error('Chưa chọn phiên')
        await rpc(active.conn, 'turn.send', { sessionKey, text, mode, clientMessageId })
      },
      onAbort: async () => {
        if (!active || !sessionKey) throw new Error('Chưa chọn phiên')
        return rpc(active.conn, 'turn.abort', { sessionKey })
      },
      onDequeue: async () => {
        if (!active || !sessionKey) throw new Error('Chưa chọn phiên')
        const r = await rpc(active.conn, 'turn.dequeue', { sessionKey })
        return r.restored
      },
      onFileSearch: async (query) => {
        if (!active || !sessionKey) return []
        const r = await rpc(active.conn, 'file.search', { sessionKey, query })
        return r.entries.map((e) => ({ path: e.path }))
      },
      onAttach: async (att: PreparedAttachment) => {
        if (!active || !sessionKey) throw new Error('Chưa chọn phiên')
        return rpc(active.conn, 'attachment.upload', {
          name: att.name,
          mime: att.mime,
          data: att.base64,
        })
      },
    }),
    [active, sessionKey],
  )

  const inspectorProps = {
    sessionKey: sessionKey ?? '',
    tab: inspectorTab,
    onTab: setInspectorTab,
    reviewDiff,
    onLoadDiff: async (scope: 'git' | 'turn', path?: string) => {
      if (!active || !sessionKey) return
      const d = await rpc(active.conn, 'review.diff', { sessionKey, scope, ...(path ? { path } : {}) })
      setReviewDiff(d)
    },
    files,
    onListFiles: async (path: string) => {
      if (!active || !sessionKey) return
      const result = await rpc(active.conn, 'file.list', { sessionKey, path })
      setFiles(result.entries.map((entry) => ({ path: entry.path, kind: entry.dir ? 'dir' : 'file' })))
    },
    onReadFile: async (path: string) => {
      if (!active) return ''
      const r = await rpc(active.conn, 'file.read', { sessionKey: sessionKey ?? '', path })
      return r.content
    },
    onCreateFile: async (path: string, dir: boolean) => {
      if (!active || !sessionKey) return
      await rpc(active.conn, 'file.create', { sessionKey, path, dir })
      const parent = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.'
      await refreshFiles(active.conn, sessionKey, parent)
    },
    onRenameFile: async (path: string, newName: string) => {
      if (!active || !sessionKey) return
      await rpc(active.conn, 'file.rename', { sessionKey, path, newName })
      const parent = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.'
      await refreshFiles(active.conn, sessionKey, parent)
    },
    stats: { context: sessionMeta.context, usage: sessionMeta.usage },
    branches,
    onSwitchBranch: async (leafId: string) => {
      if (!active || !sessionKey) return
      await rpc(active.conn, 'session.switchBranch', { sessionKey, leafId })
      await openSession(active.conn, active.hostId, sessionKey)
    },
    onAgentSteer: async (text: string) => {
      if (!active || !sessionKey) return
      await rpc(active.conn, 'turn.send', { sessionKey, text, mode: 'steer', clientMessageId: webMessageId() })
    },
    onAgentAbort: async () => {
      if (!active || !sessionKey) return
      await rpc(active.conn, 'turn.abort', { sessionKey })
    },
    onAgentResume: async (text: string) => {
      if (!active || !sessionKey) return
      await rpc(active.conn, 'turn.send', { sessionKey, text, mode: 'followUp', clientMessageId: webMessageId() })
    },
    conn: active?.conn ?? null,
    onExport: (format: 'markdown' | 'html') => {
      if (timeline) downloadExport(format, selectedSummary?.title ?? 'session', timeline.turns)
    },
    timelineTurns: timeline?.turns ?? [],
    sessionTitle: selectedSummary?.title ?? 'session',
  }

  if (connections.length === 0) {
    return <div className="workbench-empty">Chưa ghép nối host nào — ghép nối từ LiX desktop để bắt đầu.</div>
  }

  return (
    <div className="workbench">
      <div className="workbench-topbar">
        <button
          ref={mobileToggleRef}
          className="mobile-session-toggle"
          aria-label={mobileSessionListOpen ? 'Đóng danh sách phiên' : 'Mở danh sách phiên'}
          aria-controls="session-rail"
          aria-expanded={mobileSessionListOpen}
          title={mobileSessionListOpen ? 'Đóng danh sách phiên' : 'Mở danh sách phiên'}
          onClick={() => {
            setLayout((l) => ({ ...l, inspectorOpen: false }))
            setMobileSessionListOpen((open) => !open)
          }}
        >
          <Menu size={18} aria-hidden="true" />
        </button>
        <button
          className="rail-toggle"
          aria-label={layout.railOpen ? 'Thu gọn danh sách phiên' : 'Mở danh sách phiên'}
          aria-controls="session-rail"
          aria-expanded={layout.railOpen}
          title={layout.railOpen ? 'Thu gọn danh sách phiên' : 'Mở danh sách phiên'}
          onClick={() => setLayout((l) => ({ ...l, railOpen: !l.railOpen }))}
        >
          {layout.railOpen ? <PanelLeftClose size={18} aria-hidden="true" /> : <PanelLeftOpen size={18} aria-hidden="true" />}
        </button>
        <div className="topbar-spacer" />
        {sessionKey && (
          <button
            ref={inspectorToggleRef}
            className="inspector-toggle"
            aria-label={layout.inspectorOpen ? 'Đóng Inspector' : 'Mở Inspector'}
            aria-controls="workbench-inspector"
            aria-expanded={layout.inspectorOpen}
            title={layout.inspectorOpen ? 'Đóng Inspector' : 'Mở Inspector'}
            onClick={() => {
              setMobileSessionListOpen(false)
              setLayout((l) => ({ ...l, inspectorOpen: !l.inspectorOpen }))
            }}
          >
            {layout.inspectorOpen ? <PanelRightClose size={18} aria-hidden="true" /> : <PanelRightOpen size={18} aria-hidden="true" />}
          </button>
        )}
      </div>
      {notice && <div className={`banner ${notice.level}`} role="status">{notice.text}</div>}
      {slice?.state === 'connecting' || slice?.state === 'handshaking' ? <div className="banner" role="status">Đang kết nối tới host…</div> : null}
      {slice?.state === 'reconnecting' && <div className="banner warning" role="status">Mất kết nối — đang thử lại…</div>}
      {slice?.state === 'error' && <div className="banner error" role="alert">{slice.detail ?? 'Không kết nối được tới host.'}</div>}
      {slice?.state === 'closed' && <div className="banner warning" role="status">Kết nối host đã đóng.</div>}
      {slice?.detail?.includes('writer_conflict') && <div className="banner warning">Phiên đang có writer khác — chỉ xem cho tới khi handoff.</div>}
      <div
        className={`workbench-main ${layout.railOpen ? 'rail-open' : 'rail-closed'} ${layout.inspectorOpen ? 'inspector-open' : 'inspector-closed'} ${mobileSessionListOpen ? 'session-drawer-open' : ''}`.trim()}
        style={{ '--rail-w': `${layoutWidths.railWidth}px`, '--inspector-w': `${layoutWidths.inspectorWidth}px` } as CSSProperties}
      >
        {mobileSessionListOpen && <div className="scrim session-scrim" aria-hidden="true" onClick={() => setMobileSessionListOpen(false)} />}
        {layout.inspectorOpen && <div className="scrim inspector-scrim" aria-hidden="true" onClick={() => setLayout((l) => ({ ...l, inspectorOpen: false }))} />}
        <SessionRail
          footer={hostPicker}
          mobileOpen={mobileSessionListOpen && viewportWidth <= MOBILE_BREAKPOINT}
          hostId={activeHostId ?? ''}
          sessions={slice?.sessions ?? []}
          projects={slice?.projects ?? []}
          selectedProjectId={slice?.selectedProjectId ?? null}
          onSelectProject={(projectId) => activeHostId && useWorkbench.getState().selectProject(activeHostId, projectId)}
          selectedSessionKey={sessionKey}
          className={`${layout.railOpen ? '' : 'rail-collapsed'} ${mobileSessionListOpen ? 'mobile-visible' : ''}`.trim()}
          actions={{ ...railActions, onOpen: (key) => { railActions.onOpen(key); setMobileSessionListOpen(false) } }}
        />
        {layout.railOpen && (
          <ResizeSeparator
            className="rail-sep"
            label="Độ rộng panel phiên"
            min={RAIL_MIN}
            max={layoutWidths.railMax}
            value={layoutWidths.railWidth}
            onChange={(w) => setLayout((l) => ({ ...l, railWidth: clampWidth(w, RAIL_MIN, layoutWidths.railMax) }))}
          />
        )}
        <div className="workbench-center">
          {!sessionKey && <div className="empty big">Chọn một phiên để mở workbench.</div>}
          {sessionKey && timeline && (
            <>
              <ExtensionDialogs
                requests={timeline.pendingUi}
                sessionKey={sessionKey}
                actions={{
                  onRespond: async (id, response) => {
                    if (!active) return
                    const result = await rpc(active.conn, 'ui.respond', { id, ...response })
                    if (result.accepted) useWorkbench.getState().dismissUi(active.hostId, sessionKey, id)
                  },
                  onCancel: async (id) => {
                    if (!active) return
                    const result = await rpc(active.conn, 'ui.cancel', { id })
                    if (result.accepted) useWorkbench.getState().dismissUi(active.hostId, sessionKey, id)
                  },
                }}
              />
              <Timeline key={`${activeHostId}:${sessionKey}`} timeline={timeline} sessionKey={sessionKey} actions={timelineActions} onLoadOlder={async (sk, before) => {
                if (!active) return
                const initialTimeline = useWorkbench.getState().slices[active.hostId]?.timelines[sk]
                const first = initialTimeline?.turns[0]?.anchor
                if (!first || first !== before) return
                const requestGeneration = historyGeneration.current
                const timelineGeneration = initialTimeline?.timelineGeneration ?? 0
                // Discard a response raced by reset/reopen/host switch/anchor change (spec T3).
                await fetchOlderPageIfCurrent(
                  () => rpc(active.conn, 'turn.page', { sessionKey: sk, before, limit: 20 }),
                  { hostId: active.hostId, sessionKey: sk, firstAnchor: first, generation: requestGeneration, timelineGeneration },
                  () => {
                    const now = useWorkbench.getState()
                    const sliceNow = now.slices[active.hostId]
                    return {
                      activeHostId: now.activeHostId,
                      selectedSessionKey: sliceNow?.selectedSessionKey ?? null,
                      firstAnchor: sliceNow?.timelines[sk]?.turns[0]?.anchor ?? null,
                      generation: historyGeneration.current,
                      timelineGeneration: sliceNow?.timelines[sk]?.timelineGeneration ?? 0,
                    }
                  },
                  (page) => useWorkbench.getState().prependOlderTurns(active.hostId, sk, page.turns, page.hasOlder),
                )
              }} />
              <Composer
                sessionKey={sessionKey}
                running={timeline.state.running}
                queue={timeline.state.queue ?? { steering: [], followUp: [] }}
                commands={commands}
                context={sessionMeta.context}
                usage={sessionMeta.usage}
                model={selectedSummary ? (timeline.turns.at(-1)?.meta?.model ?? sessionMeta.model) : null}
                thinking={sessionMeta.thinking}
                thinkingLevels={sessionMeta.thinkingLevels}
                models={models}
                onSetModel={async (modelId) => {
                  if (!active || !sessionKey) return
                  await rpc(active.conn, 'model.set', { sessionKey, modelId })
                  setSessionMeta((m) => ({ ...m, model: modelId }))
                }}
                onSetThinking={async (level) => {
                  if (!active || !sessionKey) return
                  await rpc(active.conn, 'thinking.set', { sessionKey, level })
                  setSessionMeta((m) => ({ ...m, thinking: level }))
                }}
                actions={composerActions}
              />
            </>
          )}
        </div>
        {sessionKey && layout.inspectorOpen && (
          <>
            <ResizeSeparator
              className="inspector-sep"
              label="Độ rộng Inspector"
              min={INSPECTOR_MIN}
              max={layoutWidths.inspectorMax}
              value={layoutWidths.inspectorWidth}
              invert
              onChange={(w) => setLayout((l) => ({ ...l, inspectorWidth: clampWidth(w, INSPECTOR_MIN, layoutWidths.inspectorMax) }))}
            />
            <Inspector {...inspectorProps} modal={inspectorIsModal} />
          </>
        )}
      </div>
      {active && sessionKey && (
        <details className="workbench-settings">
          <summary>Host &amp; session settings</summary>
          <SettingsPanel
            hostId={active.hostId}
            conn={active.conn}
            sessionKey={sessionKey}
            data={settings[active.hostId] ?? null}
            hostVersions={connections.map((c) => ({
              hostId: c.hostId,
              appVersion: hostStatuses[c.hostId]?.appVersion ?? c.conn.hello?.version ?? '?',
              sdkVersion: hostStatuses[c.hostId]?.sdkVersion ?? '?',
            }))}
            onDataRefresh={async () => {
              const data = await loadSettings(active.conn, sessionKey)
              setSettings((s) => ({ ...s, [active.hostId]: data }))
            }}
          />
          <button
            onClick={() => {
              void (async () => {
                const data = await loadSettings(active.conn, sessionKey)
                setSettings((s) => ({ ...s, [active.hostId]: data }))
              })()
            }}
          >
            Tải settings
          </button>
        </details>
      )}
    </div>
  )
}

function webMessageId(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/* ── Layout: collapsible/resizable rails (spec T2) ─────────────────────── */

export type WorkbenchLayout = { railOpen: boolean; railWidth: number; inspectorOpen: boolean; inspectorWidth: number }

export const LAYOUT_KEY = 'li-web-layout'
export const RAIL_MIN = 240
export const RAIL_MAX = 720
export const INSPECTOR_MIN = 280
export const INSPECTOR_MAX = 380
export const MIN_CENTER_WIDTH = 360
export const RESIZE_GUTTER = 8
export const MOBILE_BREAKPOINT = 768
export const TABLET_WIDE_BREAKPOINT = 1000
export const DESKTOP_RESIZE_BREAKPOINT = 1025

const DEFAULT_LAYOUT: WorkbenchLayout = { railOpen: true, railWidth: 280, inspectorOpen: false, inspectorWidth: 310 }

const clampWidth = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)))

export type ResolvedWorkbenchWidths = { railWidth: number; railMax: number; inspectorWidth: number; inspectorMax: number }

/** Fit remembered panel widths to the viewport without shrinking the reading pane below its desktop floor. */
export function resolveWorkbenchWidths(layout: WorkbenchLayout, viewportWidth: number): ResolvedWorkbenchWidths {
  const width = Math.max(320, Math.floor(viewportWidth))
  let railWidth = clampWidth(layout.railWidth, RAIL_MIN, RAIL_MAX)
  let inspectorWidth = clampWidth(layout.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX)

  // At 769–999px Inspector overlays the main pane when the rail is open; it only reserves
  // a grid column in the right-only layout. At 1000px it can become the third track.
  const inspectorDocked = layout.inspectorOpen && (width >= TABLET_WIDE_BREAKPOINT || (width > MOBILE_BREAKPOINT && !layout.railOpen))
  if (width > MOBILE_BREAKPOINT && width < TABLET_WIDE_BREAKPOINT && layout.inspectorOpen) {
    inspectorWidth = Math.min(inspectorWidth, Math.floor(width * 0.44))
  }

  const gutterWidth = width >= DESKTOP_RESIZE_BREAKPOINT
    ? (layout.railOpen ? RESIZE_GUTTER : 0) + (layout.inspectorOpen ? RESIZE_GUTTER : 0)
    : 0
  if (width >= TABLET_WIDE_BREAKPOINT) {
    const railTrack = layout.railOpen ? railWidth : 0
    const inspectorTrack = inspectorDocked ? inspectorWidth : 0
    let deficit = railTrack + inspectorTrack + gutterWidth + MIN_CENTER_WIDTH - width
    if (deficit > 0 && inspectorDocked && inspectorWidth > INSPECTOR_MIN) {
      const shrink = Math.min(deficit, inspectorWidth - INSPECTOR_MIN)
      inspectorWidth -= shrink
      deficit -= shrink
    }
    if (deficit > 0 && layout.railOpen && railWidth > RAIL_MIN) {
      const shrink = Math.min(deficit, railWidth - RAIL_MIN)
      railWidth -= shrink
    }
  }

  const inspectorReservation = layout.inspectorOpen && width >= TABLET_WIDE_BREAKPOINT ? inspectorWidth : 0
  const railGutter = width >= DESKTOP_RESIZE_BREAKPOINT && layout.railOpen ? RESIZE_GUTTER : 0
  const inspectorGutter = width >= DESKTOP_RESIZE_BREAKPOINT && layout.inspectorOpen ? RESIZE_GUTTER : 0
  const railMax = Math.max(RAIL_MIN, Math.min(
    RAIL_MAX,
    Math.floor(width / 2),
    width - MIN_CENTER_WIDTH - inspectorReservation - railGutter - inspectorGutter,
  ))
  railWidth = clampWidth(railWidth, RAIL_MIN, railMax)

  const inspectorMax = width >= TABLET_WIDE_BREAKPOINT && layout.inspectorOpen
    ? Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, width - MIN_CENTER_WIDTH - (layout.railOpen ? railWidth : 0) - railGutter - inspectorGutter))
    : width > MOBILE_BREAKPOINT
      ? Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, Math.floor(width * 0.44)))
      : INSPECTOR_MAX
  inspectorWidth = clampWidth(inspectorWidth, INSPECTOR_MIN, inspectorMax)

  return { railWidth, railMax, inspectorWidth, inspectorMax }
}

/** Device-local layout preference; corrupt/unset values fall back to the defaults. */
export function loadLayout(): WorkbenchLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<WorkbenchLayout>
    return {
      railOpen: parsed.railOpen ?? DEFAULT_LAYOUT.railOpen,
      railWidth: clampWidth(parsed.railWidth ?? DEFAULT_LAYOUT.railWidth, RAIL_MIN, RAIL_MAX),
      inspectorOpen: parsed.inspectorOpen ?? DEFAULT_LAYOUT.inspectorOpen,
      inspectorWidth: clampWidth(parsed.inspectorWidth ?? DEFAULT_LAYOUT.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX),
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

/** Grid separator: pointer drag + Arrow/Home/End keyboard resize (spec T2 UX contract). */
export function ResizeSeparator({ className, label, min, max, value, onChange, invert = false }: {
  className: string
  label: string
  min: number
  max: number
  value: number
  invert?: boolean
  onChange(width: number): void
}) {
  const drag = useRef<{ start: number; base: number } | null>(null)
  const toWidth = (delta: number): number => value + (invert ? -delta : delta)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      className={`resize-sep ${className}`}
      onPointerDown={(e) => {
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* jsdom/no pointer capture */ }
        drag.current = { start: e.clientX, base: value }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        onChange(drag.current.base + (invert ? drag.current.start - e.clientX : e.clientX - drag.current.start))
      }}
      onPointerUp={(e) => {
        drag.current = null
        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
      }}
      onPointerCancel={() => { drag.current = null }}
      onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 24
        if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(clampWidth(toWidth(-step), min, max)) }
        else if (e.key === 'ArrowRight') { e.preventDefault(); onChange(clampWidth(toWidth(step), min, max)) }
        else if (e.key === 'Home') { e.preventDefault(); onChange(min) }
        else if (e.key === 'End') { e.preventDefault(); onChange(max) }
      }}
    />
  )
}

// SessionSummary type re-declared locally to avoid widening the import surface in this shell.
type SessionSummaryFor = import('@shared/remote').SessionSummary
