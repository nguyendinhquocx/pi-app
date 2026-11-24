import { create } from 'zustand'
import type { SessionSummary, ProjectInfo } from '@shared/remote'
import { REMOTE_METHODS, type RemoteMethod, type MethodParams, type MethodResult, type EventPayload } from '@shared/remote'
import type { HostConnection, ConnState } from '../transport/host-connection'
import { DisconnectedError, RpcRejectedError } from '../transport/host-connection'
import { emptyTimeline, addUi, removeUi, prependOlder, applyAll, type SessionTimeline } from './timeline-store'
import type { OpenResult } from '@shared/remote'
import type { BackoffOptions } from '../transport/reconnect'
import type { DeviceKeyRecord } from '../transport/device-keys'
import type { WebUiRequest } from '../transport/web-ui-request'

/**
 * Workbench state (spec T4): per-host session namespaces NEVER merge — every host owns an
 * isolated slice keyed by hostId, and the active host determines which slice renders. States
 * surface loading/empty/error/disconnected/owner-busy/stream per the UX contract.
 */

export type HostSlice = {
  state: ConnState
  detail: string | null
  role: 'viewer' | 'operator' | null
  ownerProtocol: number | null
  projects: ProjectInfo[]
  selectedProjectId: string | null
  sessions: SessionSummary[]
  selectedSessionKey: string | null
  timelines: Record<string, SessionTimeline>
}

export type WorkbenchState = {
  slices: Record<string, HostSlice>
  activeHostId: string | null
  /** Global notice line (connection-level), separate from in-session state. */
  notice: { level: 'info' | 'warning' | 'error'; text: string } | null
}

export type WorkbenchActions = {
  ensureSlice(hostId: string): void
  setConnState(hostId: string, state: ConnState, detail?: string | null): void
  setSessionInfo(hostId: string, info: { role: 'viewer' | 'operator' | null; ownerProtocol: number | null }): void
  setProjects(hostId: string, projects: ProjectInfo[]): void
  selectProject(hostId: string, projectId: string | null): void
  setSessions(hostId: string, sessions: SessionSummary[], removed?: string[]): void
  /** Incremental `sessions.update` delta: upsert dirty rows, apply removals, keep the rest (F2 fix). */
  mergeSessionDeltas(hostId: string, sessions: SessionSummary[], removed?: string[]): void
  selectSession(hostId: string, sessionKey: string | null): void
  setTimeline(hostId: string, sessionKey: string, timeline: SessionTimeline): void
  appendUi(hostId: string, sessionKey: string, req: Parameters<typeof addUi>[1]): void
  dismissUi(hostId: string, sessionKey: string, id: string): void
  /** Apply turn.patch with gap detection; returns false when a gap opened (caller re-opens). */
  applyPatch(hostId: string, sessionKey: string, patches: Parameters<typeof applyAll>[1]): boolean
  prependOlderTurns(hostId: string, sessionKey: string, older: Parameters<typeof prependOlder>[1], hasOlder: boolean): void
  setActiveHost(hostId: string | null): void
  setNotice(level: 'info' | 'warning' | 'error' | null, text?: string): void
  resetHost(hostId: string): void
}

export type WorkbenchStore = WorkbenchState & WorkbenchActions

const emptySlice = (): HostSlice => ({
  state: 'idle',
  detail: null,
  role: null,
  ownerProtocol: null,
  projects: [],
  selectedProjectId: null,
  sessions: [],
  selectedSessionKey: null,
  timelines: {},
})

export const useWorkbench = create<WorkbenchStore>((set, get) => ({
  slices: {},
  activeHostId: null,
  notice: null,
  ensureSlice(hostId) {
    if (!get().slices[hostId]) set((s) => ({ slices: { ...s.slices, [hostId]: emptySlice() } }))
  },
  setConnState(hostId, state, detail = null) {
    get().ensureSlice(hostId)
    set((s) => ({ slices: { ...s.slices, [hostId]: { ...s.slices[hostId], state, detail } } }))
  },
  setSessionInfo(hostId, info) {
    get().ensureSlice(hostId)
    set((s) => ({ slices: { ...s.slices, [hostId]: { ...s.slices[hostId], ...info } } }))
  },
  setProjects(hostId, projects) {
    get().ensureSlice(hostId)
    set((s) => ({ slices: { ...s.slices, [hostId]: { ...s.slices[hostId], projects } } }))
  },
  selectProject(hostId, projectId) {
    get().ensureSlice(hostId)
    set((s) => {
      const slice = s.slices[hostId]
      const selectedSessionKey = slice.sessions.some((session) => session.sessionKey === slice.selectedSessionKey && (!projectId || projectId === 'all' || session.projectId === projectId))
        ? slice.selectedSessionKey
        : null
      return { slices: { ...s.slices, [hostId]: { ...slice, selectedProjectId: projectId === 'all' ? null : projectId, selectedSessionKey } } }
    })
  },
  setSessions(hostId, sessions, removed) {
    get().ensureSlice(hostId)
    set((s) => {
      const slice = s.slices[hostId]
      const timelines = { ...slice.timelines }
      for (const key of removed ?? []) {
        if (timelines[key] && key !== slice.selectedSessionKey) delete timelines[key]
      }
      return { slices: { ...s.slices, [hostId]: { ...slice, sessions, timelines } } }
    })
  },
  mergeSessionDeltas(hostId, sessions, removed) {
    get().ensureSlice(hostId)
    set((s) => {
      const slice = s.slices[hostId]
      const byKey = new Map(slice.sessions.map((row) => [row.sessionKey, row]))
      // Upsert only the dirty rows the host flushed (F2: `sessions.update` is incremental,
      // NOT a snapshot — replacing the list here collapsed the rail to the delta).
      for (const row of sessions ?? []) byKey.set(row.sessionKey, row)
      const removedSet = new Set(removed ?? [])
      for (const key of removedSet) byKey.delete(key)
      const nextSessions = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      const timelines = { ...slice.timelines }
      for (const key of removedSet) {
        if (timelines[key] && key !== slice.selectedSessionKey) delete timelines[key]
      }
      return { slices: { ...s.slices, [hostId]: { ...slice, sessions: nextSessions, timelines } } }
    })
  },
  selectSession(hostId, sessionKey) {
    get().ensureSlice(hostId)
    set((s) => ({ slices: { ...s.slices, [hostId]: { ...s.slices[hostId], selectedSessionKey: sessionKey } } }))
  },
  setTimeline(hostId, sessionKey, timeline) {
    get().ensureSlice(hostId)
    set((s) => {
      const slice = s.slices[hostId]
      return { slices: { ...s.slices, [hostId]: { ...slice, timelines: { ...slice.timelines, [sessionKey]: timeline } } } }
    })
  },
  appendUi(hostId, sessionKey, req) {
    const slice = get().slices[hostId]
    const t = slice?.timelines[sessionKey]
    if (!t) return
    get().setTimeline(hostId, sessionKey, addUi(t, req))
  },
  dismissUi(hostId, sessionKey, id) {
    const slice = get().slices[hostId]
    const t = slice?.timelines[sessionKey]
    if (!t) return
    get().setTimeline(hostId, sessionKey, removeUi(t, id))
  },
  applyPatch(hostId, sessionKey, patches) {
    const slice = get().slices[hostId]
    const t = slice?.timelines[sessionKey]
    if (!t) return false
    const result = applyAll(t, patches)
    if (!result.ok) return false
    get().setTimeline(hostId, sessionKey, result.timeline)
    return true
  },
  prependOlderTurns(hostId, sessionKey, older, hasOlder) {
    const slice = get().slices[hostId]
    const t = slice?.timelines[sessionKey]
    if (!t) return
    get().setTimeline(hostId, sessionKey, prependOlder(t, older, hasOlder))
  },
  setActiveHost(hostId) {
    if (hostId) get().ensureSlice(hostId)
    set({ activeHostId: hostId })
  },
  setNotice(level, text) {
    set({ notice: level ? { level, text: text ?? '' } : null })
  },
  resetHost(hostId) {
    set((s) => {
      const slices = { ...s.slices }
      delete slices[hostId]
      return {
        slices,
        activeHostId: s.activeHostId === hostId ? null : s.activeHostId,
        notice: s.notice,
      }
    })
  },
}))

/** Selector helpers */
export function activeSlice(s: WorkbenchState): HostSlice | null {
  return s.activeHostId ? s.slices[s.activeHostId] ?? null : null
}


export function activeTimeline(s: WorkbenchState): SessionTimeline | null {
  const slice = activeSlice(s)
  if (!slice?.selectedSessionKey) return null
  return slice.timelines[slice.selectedSessionKey] ?? null
}

/**
 * Open a session AND populate the store timeline from the snapshot/replay result (the RPC
 * itself is req/res, not an event — without this the store would never learn the baseline).
 */
export async function openSessionInStore(
  conn: HostConnection,
  hostId: string,
  sessionKey: string,
  cursor?: { epoch: string; seq: number },
): Promise<Awaited<ReturnType<HostConnection['openSession']>>> {
  const result = await conn.openSession(sessionKey, cursor)
  // The onSessionOpen listener applies the RPC response synchronously when this connection is
  // wired to the store. Keep a direct fallback for tests/standalone callers without the listener.
  const current = useWorkbench.getState().slices[hostId]?.timelines[sessionKey]
  const next = applyOpenResult(current, result)
  if (next) useWorkbench.getState().setTimeline(hostId, sessionKey, next)
  return result
}

function applyOpenResult(current: SessionTimeline | undefined, result: OpenResult): SessionTimeline | null {
  if (result.kind === 'snapshot' || result.resync) {
    return {
      turns: result.turns ?? [],
      seq: result.seq,
      timelineGeneration: (current?.timelineGeneration ?? 0) + 1,
      state: result.state,
      pendingUi: result.pendingUi,
      hasOlder: result.hasOlder ?? false,
    }
  }
  if (!current) return null
  const replay = applyAll(current, result.patches ?? [])
  if (!replay.ok) return null
  return {
    ...replay.timeline,
    seq: result.seq,
    timelineGeneration: replay.timeline.timelineGeneration,
    state: result.state,
    pendingUi: result.pendingUi,
    hasOlder: result.hasOlder ?? replay.timeline.hasOlder,
  }
}

/**
 * Wire a HostConnection into the store: state/session/patch events flow one way; RPC calls go
 * through `rpc()` which maps owner errors to user-facing codes (spec UX contract states).
 */
export function connectStore(conn: HostConnection, hostId: string, store: { getState(): WorkbenchStore } = useWorkbench): void {
  store.getState().ensureSlice(hostId)
  const H = conn.hostId
  void hostId
  conn.bindEvents({
    onState: (state, detail) => store.getState().setConnState(H, state, detail ?? null),
    onHello: (hello) => {
      store.getState().setSessionInfo(H, { role: hello.role, ownerProtocol: hello.ownerProtocol ?? null })
    },
    onResync: (_sessionKey) => {
      // The session.open response already contains the forced snapshot/replay result; the
      // onSessionOpen handler below applies it. Do not issue a duplicate open here.
    },
    onSessionOpen: (sessionKey, result) => {
      const current = store.getState().slices[H]?.timelines[sessionKey]
      const next = applyOpenResult(current, result)
      if (next) store.getState().setTimeline(H, sessionKey, next)
      else {
        // Replay without a local baseline or with a sequence gap: request an un-cursored snapshot.
        void openSessionInStore(conn, H, sessionKey).catch(() => undefined)
      }
    },
    onEvent: (event, payload) => {
      if (event === 'sessions.update') {
        const p = payload as EventPayload<'sessions.update'>
        store.getState().mergeSessionDeltas(H, p.sessions, p.removed)
        return
      }
      if (event === 'ui.request') {
        const p = payload as WebUiRequest
        if (p.method === 'notify') {
          store.getState().setNotice(p.notifyType ?? 'info', p.message)
          return
        }
        store.getState().appendUi(H, p.sessionKey, p)
        return
      }
      if (event === 'ui.dismiss') {
        const p = payload as EventPayload<'ui.dismiss'>
        store.getState().dismissUi(H, p.sessionKey, p.id)
        return
      }
      if (event === 'host.notice') {
        const p = payload as EventPayload<'host.notice'>
        store.getState().setNotice(p.level, p.text)
        return
      }
      if (event === 'turn.patch') {
        const p = payload as EventPayload<'turn.patch'>
        const ok = store.getState().applyPatch(H, p.sessionKey, p.patches)
        if (!ok) {
          // Gap -> forced re-open (snapshot path), matches the connection's resync contract.
          store.getState().setTimeline(H, p.sessionKey, emptyTimeline())
          void openSessionInStore(conn, H, p.sessionKey).catch(() => undefined)
        }
      }
    },
  })
}

/**
 * Typed RPC wrapper with owner-error mapping (spec UX contract: owner busy / handoff states
 * surface as named errors, never generic failures).
 */
export async function rpc<M extends RemoteMethod>(
  conn: HostConnection,
  method: M,
  params: MethodParams<M>,
): Promise<MethodResult<M>> {
  try {
    return (await conn.request(method, params)) as MethodResult<M>
  } catch (e) {
    if (e instanceof DisconnectedError) throw new Error('Mất kết nối với host — đang thử kết nối lại')
    if (e instanceof RpcRejectedError) {
      if (e.rpcError.code === 'writer_conflict') throw new Error('Session đang có writer khác chạy — chỉ xem, chờ handoff')
      if (e.rpcError.code === 'owner_unavailable') throw new Error('Không chứng minh được quyền ghi (strict mode) — thử lại')
      throw e
    }
    throw e
  }
}

export type { BackoffOptions, DeviceKeyRecord }
