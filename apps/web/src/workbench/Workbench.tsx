import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommandInfo, BranchInfo, ContextStats, SessionUsage, MethodResult } from '@shared/remote'
import { useWorkbench, activeSlice, activeTimeline, connectStore } from './workbench-store'
import { openSessionInStore } from './workbench-store'
import type { HostConnection } from '../transport/host-connection'
import { rpc } from './workbench-store'
import { SessionRail, type SessionRailActions } from './SessionRail'
import { Timeline } from './Timeline'
import { Composer, type ComposerActions } from './Composer'
import { Inspector, downloadExport, type InspectorTab } from './Inspector'
import { ExtensionDialogs } from './ExtensionDialogs'
import { SettingsPanel, loadSettings, type SettingsData } from './SettingsPanel'
import type { PreparedAttachment } from '../features/upload'

/**
 * Workbench shell (spec T4 UX contract): host rail → session rail → timeline/composer →
 * inspector. States surface in-place (banner, rail notices, stream indicator) — no modal ever
 * hides a running task or claims a false stop.
 */

export type WorkbenchConnection = { hostId: string; conn: HostConnection }

export function Workbench({ connections, onCloseHost }: { connections: WorkbenchConnection[]; onCloseHost?(hostId: string): void }) {
  const slices = useWorkbench((s) => s.slices)
  const activeHostId = useWorkbench((s) => s.activeHostId)
  const setActiveHost = useWorkbench((s) => s.setActiveHost)
  const setSessions = useWorkbench((s) => s.setSessions)
  const notice = useWorkbench((s) => s.notice)

  const [settings, setSettings] = useState<Record<string, SettingsData>>({})
  const [hostStatuses, setHostStatuses] = useState<Record<string, { appVersion: string; sdkVersion: string }>>({})
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('context')
  const [reviewDiff, setReviewDiff] = useState<MethodResult<'review.diff'> | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [files, setFiles] = useState<{ path: string; kind: string }[]>([])
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [sessionMeta, setSessionMeta] = useState<{ model: string | null; thinking: string | null; thinkingLevels: string[]; context: ContextStats | null; usage: SessionUsage | null }>({ model: null, thinking: null, thinkingLevels: [], context: null, usage: null })
  const [mobileSessionListOpen, setMobileSessionListOpen] = useState(false)
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
        setModels(modelsResult.models.map((m) => ({ id: m.id, name: m.name ?? m.id })))
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
      <nav className="host-rail" aria-label="Hosts">
        <button className="mobile-session-toggle" onClick={() => setMobileSessionListOpen((open) => !open)} aria-expanded={mobileSessionListOpen}>
          Sessions{selectedSummary?.title ? ` · ${selectedSummary.title}` : ''}
        </button>
        {connections.map((c) => {
          const s = slices[c.hostId]
          const dot = s?.state === 'online' ? 'online' : s?.state === 'error' ? 'error' : 'connecting'
          return (
            <div key={c.hostId} className={`host-chip ${c.hostId === activeHostId ? 'active' : ''}`}>
              <button onClick={() => setActiveHost(c.hostId)}>
                <span className={`host-dot ${dot}`} aria-hidden="true" />
                <span title={c.hostId}>{c.conn.hello?.hostName ?? c.hostId}</span>
              </button>
              {onCloseHost && (
                <button className="host-close" aria-label={`Ngắt ${c.hostId}`} onClick={() => onCloseHost(c.hostId)}>×</button>
              )}
            </div>
          )
        })}
      </nav>
      {notice && <div className={`banner ${notice.level}`} role="status">{notice.text}</div>}
      {slice?.state === 'connecting' || slice?.state === 'handshaking' ? <div className="banner" role="status">Đang kết nối tới host…</div> : null}
      {slice?.state === 'reconnecting' && <div className="banner warning" role="status">Mất kết nối — đang thử lại…</div>}
      {slice?.state === 'error' && <div className="banner error" role="alert">{slice.detail ?? 'Không kết nối được tới host.'}</div>}
      {slice?.state === 'closed' && <div className="banner warning" role="status">Kết nối host đã đóng.</div>}
      {slice?.detail?.includes('writer_conflict') && <div className="banner warning">Phiên đang có writer khác — chỉ xem cho tới khi handoff.</div>}
      <div className="workbench-main">
        <SessionRail
          hostId={activeHostId ?? ''}
          sessions={slice?.sessions ?? []}
          projects={slice?.projects ?? []}
          selectedProjectId={slice?.selectedProjectId ?? null}
          onSelectProject={(projectId) => activeHostId && useWorkbench.getState().selectProject(activeHostId, projectId)}
          selectedSessionKey={sessionKey}
          className={mobileSessionListOpen ? 'mobile-visible' : ''}
          actions={{ ...railActions, onOpen: (key) => { railActions.onOpen(key); setMobileSessionListOpen(false) } }}
        />
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
              <Timeline timeline={timeline} sessionKey={sessionKey} actions={timelineActions} onLoadOlder={async (sk) => {
                if (!active) return
                const first = useWorkbench.getState().slices[active.hostId]?.timelines[sk]?.turns[0]?.anchor
                if (!first) return
                const page = await rpc(active.conn, 'turn.page', { sessionKey: sk, before: first, limit: 20 })
                useWorkbench.getState().prependOlderTurns(active.hostId, sk, page.turns, page.hasOlder)
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
        {sessionKey && <Inspector {...inspectorProps} />}
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

// SessionSummary type re-declared locally to avoid widening the import surface in this shell.
type SessionSummaryFor = import('@shared/remote').SessionSummary
