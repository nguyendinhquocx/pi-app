import { app, safeStorage } from 'electron'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import type { CacheWarming, UiResponse } from '@shared/remote'
import { normalizeSessionFileKey } from '@shared/session-file-key'
import { normalizeCapabilities } from '@shared/capabilities'
import { wslPathToWindows } from '@shared/wsl-path'
import { findAdapterByTool } from '../extension-compat/adapter-loader'
import type { ExtensionProbeResult } from '../extension-compat/extension-probe'
import { capabilityCatalog, capabilitySectionMap, capabilityToolFamilies } from './capabilities/catalog'
import { readRemoteAttachment, writeRemoteAttachment } from './clipboard-temp-images'
import { configStore } from './config-store'
import { getSessionLeafOverride, setSessionLeafOverride } from './session-leaf-override'
import { workspaceFsCreate, workspaceFsListDir, workspaceFsReadText, workspaceFsRename } from './workspace-fs'
import { workspaceFsSearch } from './workspace-file-search'
import { scanStaticSlashCommands } from './commands-catalog'
import { probeExtensionsShared } from './extension-probe-cache'
import { getDesktopSkillOverrides, isSkillEnabled, setSkillEnabledInGlobal } from './pi-skill-overrides'
import { readBuiltinSdkVersion, resolveActiveSdk } from './sdk-loader'
import { getActiveAgentDir } from '../extension-compat/active-dirs'

/** Small mime guess for file previews (the remote client only uses it as a rendering hint). */
function guessMime(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const table: Record<string, string> = {
    md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', json: 'application/json',
    ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    py: 'text/x-python', rs: 'text/x-rust', go: 'text/x-go', kt: 'text/x-kotlin', java: 'text/x-java',
    css: 'text/css', html: 'text/html', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
    toml: 'text/plain', csv: 'text/csv', sh: 'text/x-shellscript', ps1: 'text/x-powershell',
  }
  return table[ext] ?? 'text/plain'
}
import { awaitWslVm } from './wsl/wsl-env'
import { isSandboxWorkspacePath, sandboxLabel } from './sandbox-workspaces'
import { invokeHandler } from './ipc/registry'
import type { HostLiveState, HostModelList, HostSessionHistory, HostSessionRow, HostTimelineItem, RemoteHostPort, SendMode } from './remote/host-port'
import { sessionPreviewProcess } from './session-preview-process'
import { readSessionMetaFromFile } from './session-file-meta'
import { getTrustedWorkspaceRoot } from './trusted-workspace'
import { readGitDiffVsHead } from './git-workspace'
import { sessionUsage } from './usage-scan'
import { getMainWindow } from './window'
import { workerManager } from './worker-manager'
import { remoteTerminals } from './terminal/remote-terminal-bridge'
import { getAgentRuntimeConfig } from './wsl/runtime-config'
import { noteBrowserTarget } from './browser/targets'

/**
 * Electron implementation of the remote gateway's port. Reads go through the same registered
 * IPC handlers the renderer uses (authorization, WSL mapping, preview process); writes call
 * workerManager with an explicit sessionFile. Nothing here touches the desktop's foreground
 * session, pending bind or current workspace.
 */

const MAX_REMEMBERED_CAPABILITIES = 300
const MODEL_GROUP_ORDER = { custom: 0, apiKey: 1, login: 2 } as const

function modelGroup(auth?: { source?: string; type?: string }): 'custom' | 'apiKey' | 'login' {
  if (auth?.type === 'oauth') return 'login'
  if (auth?.source === 'models_json_key' || auth?.source === 'models_json_command') return 'custom'
  return 'apiKey'
}
const HOST_KEY_FILE = 'remote-host.key'
const HOST_KEY_FILE_MARK = 'file:remote-host.key'

function safeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}
/** Same scale as the desktop thinking picker (renderer `THINKING_LEVELS`). */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const comparable = (p: string) => normalizeSessionFileKey(p).replace(/\/+$/, '').toLowerCase()

type ListedSession = { sessionFile: string; title: string; createdAt: number; updatedAt: number; firstMessage?: string }

function trustedProjects(): string[] {
  const all = [getTrustedWorkspaceRoot(), ...(configStore.get('recentProjects') || [])].filter((p): p is string => !!p)
  const seen = new Set<string>()
  return all.filter((p) => {
    const k = comparable(p)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function sendToRenderer(channel: string, payload: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

export function createElectronRemoteHost(): RemoteHostPort {
  return {
    hostName: () => hostname(),
    appVersion: () => app.getVersion(),
    trustedProjects,

    async listSessions(projectId: string): Promise<HostSessionRow[]> {
      const r = await invokeHandler<{ sessions?: ListedSession[] }>('ipc:session.list', { workspaceId: projectId })
      return (r.sessions ?? []).map((s) => ({
        sessionFile: s.sessionFile,
        projectId,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        ...(s.firstMessage ? { firstMessage: s.firstMessage } : {}),
      }))
    },

    projectInfo(path: string) {
      if (!isSandboxWorkspacePath(path)) return {}
      const label = sandboxLabel(path)
      return { temporary: true, ...(label ? { label } : {}) }
    },

    async sessionProject(sessionFile: string): Promise<string | null> {
      const cwd = (await readSessionMetaFromFile(sessionFile).catch(() => null))?.cwd
      if (!cwd) return null
      const runtime = getAgentRuntimeConfig()
      const candidates = [cwd]
      if (runtime.mode === 'wsl' && runtime.distro) candidates.push(wslPathToWindows(runtime.distro, cwd))
      const trusted = trustedProjects()
      for (const c of candidates) {
        const hit = trusted.find((t) => comparable(t) === comparable(c))
        if (hit) return hit
      }
      return cwd
    },

    async readHistory(projectId: string, sessionFile: string): Promise<HostSessionHistory> {
      const r = await invokeHandler<{ items?: HostTimelineItem[]; error?: string; sessionMeta?: { model?: string; thinkingLevel?: string } }>(
        'ipc:session.getMessages',
        { sessionFile, workspaceId: projectId },
      )
      if (r.error) throw new Error(r.error)
      return { items: r.items ?? [], model: r.sessionMeta?.model, thinking: r.sessionMeta?.thinkingLevel }
    },

    async liveState(sessionFile: string): Promise<HostLiveState> {
      const st = (await workerManager.getState(sessionFile).catch(() => ({}))) as {
        isStreaming?: boolean
        model?: string
        thinkingLevel?: string
        availableThinkingLevels?: string[]
      }
      return {
        running: !!st.isStreaming,
        ...(st.model ? { model: st.model } : {}),
        ...(st.thinkingLevel ? { thinking: st.thinkingLevel } : {}),
        ...(st.availableThinkingLevels ? { availableThinking: st.availableThinkingLevels } : {}),
      }
    },

    async send(sessionFile: string, text: string, mode: SendMode, capabilities: string[], projectId: string): Promise<void> {
      // Same sequence as the prompt handlers, minus the pending-bind bookkeeping that belongs
      // to the desktop UI: bind this session's worker (no foreground change), apply capabilities, send.
      // A session created from the phone has a live worker but no file until its first reply:
      // re-loading it would read a missing header, so only cold sessions go through loadSession.
      if (!workerManager.hasLiveSessionWorker(sessionFile)) await workerManager.loadSession(sessionFile, { cwd: projectId })
      noteBrowserTarget(sessionFile, capabilities)
      await workerManager.setCapabilities(capabilitySectionMap(capabilities), capabilityToolFamilies(capabilities), sessionFile)
      if (mode === 'steer') await workerManager.steer(text, sessionFile)
      else if (mode === 'followUp') await workerManager.followUp(text, sessionFile)
      else await workerManager.sendPrompt(text, sessionFile)
    },

    abort: (sessionFile) => workerManager.abort(sessionFile),

    async rewind(sessionFile: string, anchor: string, projectId: string) {
      // Same as the desktop rewind, on this session's own worker (never the foreground one).
      if (!workerManager.hasLiveSessionWorker(sessionFile)) await workerManager.loadSession(sessionFile, { cwd: projectId })
      const r = await workerManager.navigateTree(anchor, { summarize: false, sessionFile })
      if (r.cancelled) throw new Error(r.error || 'rewind_cancelled')
      // pi keeps the leaf in memory only: persist it so history reads and later loads follow the branch.
      setSessionLeafOverride(sessionFile, r.leafId !== undefined ? r.leafId : anchor)
      return r.editorText ? { editorText: r.editorText } : {}
    },

    async sessionTree(sessionFile: string, projectId: string) {
      // Same leaf as the desktop tree: the persisted override, else the live worker's leaf.
      let leafId = getSessionLeafOverride(sessionFile)
      if (leafId === undefined && workerManager.hasLiveSessionWorker(sessionFile)) {
        const st = (await workerManager.getState(sessionFile).catch(() => null)) as { leafId?: string | null } | null
        if (st && 'leafId' in st) leafId = st.leafId ?? null
      }
      const r = await sessionPreviewProcess.getTree({ sessionFile, cwd: projectId, leafId })
      return { rows: r.nodes, leafId: r.leafId }
    },

    async switchBranch(sessionFile: string, leafId: string, projectId: string) {
      if (!workerManager.hasLiveSessionWorker(sessionFile)) await workerManager.loadSession(sessionFile, { cwd: projectId })
      const r = await workerManager.navigateTree(leafId, { summarize: false, sessionFile })
      if (r.cancelled) throw new Error(r.error || 'switch_cancelled')
      setSessionLeafOverride(sessionFile, r.leafId !== undefined ? r.leafId : leafId)
    },

    async fork(sessionFile: string, anchor: string, projectId: string) {
      // File-level branch (pi SessionManager), not the desktop fork: that one re-focuses the
      // foreground worker onto the fork, which would pull the desktop's view away.
      const { SessionManager } = await import('@earendil-works/pi-coding-agent')
      const sm = SessionManager.open(sessionFile, dirname(sessionFile), projectId)
      const entry = sm.getEntry(anchor) as { parentId?: string | null; message?: { role?: string; content?: unknown } } | undefined
      if (!entry || entry.message?.role !== 'user') throw new Error('entry not found')
      const content = entry.message.content
      const editorText = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c?.type === 'text' ? c.text ?? '' : '')).join('') : ''
      // Forking before the first message is just a new session with that message to edit.
      const forked = entry.parentId ? sm.createBranchedSession(entry.parentId) : undefined
      const file = forked ?? (await this.createSession(projectId))
      void sessionPreviewProcess.invalidateListSessions(projectId).catch(() => {})
      return { sessionFile: file, ...(editorText ? { editorText } : {}) }
    },

    async renameSession(sessionFile: string, title: string, projectId: string): Promise<string> {
      const r = await invokeHandler<{ ok?: boolean; title?: string; error?: string }>('ipc:session.rename', { sessionFile, title, workspaceId: projectId })
      if (!r.ok) throw new Error(r.error || 'rename failed')
      return r.title || title
    },

    async deleteSession(sessionFile: string, projectId: string): Promise<boolean> {
      const r = await invokeHandler<{ ok?: boolean; error?: string }>('ipc:session.delete', { sessionFile, workspaceId: projectId })
      if (!r.ok) throw new Error(r.error || 'delete failed')
      void sessionPreviewProcess.invalidateListSessions(projectId).catch(() => {})
      return true
    },

    async cloneSession(sessionFile: string, projectId: string): Promise<string> {
      if (!workerManager.hasLiveSessionWorker(sessionFile)) await workerManager.loadSession(sessionFile, { cwd: projectId })
      const r = await workerManager.cloneSession({ sessionFile })
      if (!r.sessionFile) throw new Error(r.error || 'clone failed')
      void sessionPreviewProcess.invalidateListSessions(projectId).catch(() => {})
      return r.sessionFile
    },

    async clearQueue(sessionFile: string): Promise<string[]> {
      // Never spawn a worker just to read an empty queue.
      if (!workerManager.hasLiveSessionWorker(sessionFile)) return []
      const q = await workerManager.clearPromptQueue(sessionFile)
      return [...q.steering, ...q.followUp].filter(Boolean)
    },

    async createSession(projectId: string): Promise<string> {
      const result = await workerManager.newSessionInBackground(projectId)
      if (!result.sessionFile) throw new Error('session_not_created')
      void sessionPreviewProcess.invalidateListSessions(projectId).catch(() => {})
      return result.sessionFile
    },

    async listModels(sessionFile: string): Promise<HostModelList> {
      const [list, state] = await Promise.all([
        invokeHandler<{ models?: Array<{ id: string; name?: string; provider?: string; available?: boolean; auth?: { source?: string; type?: string } }> }>('ipc:model.list', { scope: 'available' }),
        this.liveState(sessionFile),
      ])
      return {
        models: (list.models ?? [])
          .filter((m) => m.available !== false)
          .map((m) => ({
            id: m.provider ? `${m.provider}/${m.id}` : m.id,
            ...(m.name ? { name: m.name } : {}),
            ...(m.provider ? { provider: m.provider } : {}),
            group: modelGroup(m.auth),
          }))
          // Custom (models.json) first, then API-key providers, then OAuth sign-ins; stable within a group.
          .sort((a, b) => MODEL_GROUP_ORDER[a.group] - MODEL_GROUP_ORDER[b.group]),
        ...(state.model ? { current: state.model } : {}),
        ...(state.thinking ? { thinking: state.thinking } : {}),
        // A session without a bound worker reports no levels; offer the full scale like the desktop picker.
        availableThinking: state.availableThinking?.length ? state.availableThinking : [...THINKING_LEVELS],
      }
    },

    async setModel(sessionFile: string, modelId: string): Promise<string> {
      const r = await invokeHandler<{ modelId?: string }>('ipc:model.set', { sessionFile, modelId })
      return r.modelId || modelId
    },

    async saveAttachment(bytes: Uint8Array, name: string): Promise<string> {
      return writeRemoteAttachment(bytes, name)
    },

    async readAttachment(path: string) {
      return readRemoteAttachment(path)
    },

    async setThinking(sessionFile: string, level: string): Promise<void> {
      await invokeHandler('ipc:thinkingLevel.set', { sessionFile, level })
    },

    respondUi: (response: UiResponse) => workerManager.respondExtensionUI(response),
    cancelUi: (id: string) => workerManager.cancelExtensionUI(id, 'remote-cancel'),
    dismissDesktopUi: (id: string) => sendToRenderer('ipc:extension-ui-dismiss', { type: 'extension-ui-dismiss', id, reason: 'remote-answered' }),

    async listCommands(projectId: string) {
      // Same catalog the desktop composer shows before a worker is bound: disk prompts, skills
      // (minus the ones disabled in settings) and extension commands for that project.
      await awaitWslVm()
      const overrides = getDesktopSkillOverrides()
      return scanStaticSlashCommands(projectId, await probeExtensionsShared(projectId))
        .filter((c) => c.category !== 'skill' || isSkillEnabled(String(c.id || c.name).replace(/^\/?skill:/, ''), c.source?.path || c.source?.filePath, overrides))
        .map((c) => ({ name: c.name, description: c.description || undefined, category: c.category }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    async contextStats(sessionFile: string, projectId: string) {
      const [r, state, list] = await Promise.all([
        invokeHandler<{ preview?: { messageCount: number; estimatedChars: number; roleBreakdown: Array<{ role: string; chars: number }> } | null }>(
          'ipc:context.preview',
          { sessionFile, workspaceId: projectId },
        ),
        this.liveState(sessionFile),
        invokeHandler<{ models?: Array<{ id: string; provider?: string; contextWindow?: number }> }>('ipc:model.list', { scope: 'available' }).catch(() => ({ models: [] })),
      ])
      const p = r.preview
      if (!p) return null
      const tokens = (chars: number) => Math.round(chars / 4)
      const current = state.model
      const model = current ? list.models?.find((m) => (m.provider ? `${m.provider}/${m.id}` : m.id) === current || m.id === current) : undefined
      return {
        tokens: tokens(p.estimatedChars),
        ...(model?.contextWindow ? { window: Math.round(model.contextWindow) } : {}),
        messages: p.messageCount,
        breakdown: p.roleBreakdown.slice(0, 12).map((s) => ({ role: s.role, tokens: tokens(s.chars) })),
      }
    },

    gitDiff: (projectId: string) => readGitDiffVsHead(projectId),

    async sessionUsage(sessionFile: string) {
      const u = sessionUsage(sessionFile)
      if (!u) return null
      const { reasoning: _r, ...wire } = u
      void _r
      return wire
    },

    async listDir(projectId: string, path: string, dotfiles: boolean) {
      const r = await workspaceFsListDir({ workspaceRoot: projectId, path, includeDotfiles: dotfiles })
      if (!r.ok) return null
      return {
        entries: r.entries.map((e) => ({ name: e.name, path: e.path, dir: e.isDirectory, size: e.size, mtime: e.mtimeMs == null ? undefined : Math.round(e.mtimeMs) })),
        truncated: r.truncated,
      }
    },

    async searchFiles(projectId: string, query: string) {
      const r = await workspaceFsSearch({ workspaceRoot: projectId, query, maxResults: 60 })
      return r.ok ? r.entries.map((e) => ({ name: e.name, path: e.path, dir: e.isDirectory })) : []
    },

    async readFilePreview(projectId: string, path: string): Promise<{ content: string; size: number; truncated: boolean; mime: string } | null> {
      const r = await workspaceFsReadText({ workspaceRoot: projectId, path })
      if (!r.ok) return null
      return { content: r.content, size: r.size, truncated: !!r.truncated, mime: guessMime(path) }
    },

    async createFile(projectId: string, path: string, dir?: boolean): Promise<string> {
      const r = await workspaceFsCreate({ workspaceRoot: projectId, relativePath: path, isDirectory: dir === true })
      if (!r.ok) throw new Error(r.error)
      return path
    },

    async renameFile(projectId: string, path: string, newName: string): Promise<string> {
      const r = await workspaceFsRename({ workspaceRoot: projectId, relativePath: path, newName })
      if (!r.ok) throw new Error(r.error)
      return r.newRelativePath
    },

    async listSkills(projectId: string): Promise<Array<{ name: string; description?: string; enabled: boolean; source?: 'global' | 'project' }>> {
      await awaitWslVm()
      const overrides = getDesktopSkillOverrides()
      return scanStaticSlashCommands(projectId, await probeExtensionsShared(projectId))
        .filter((c) => c.category === 'skill')
        .map((c) => ({
          name: String(c.id || c.name).replace(/^\/?skill:/, ''),
          ...(c.description ? { description: c.description.slice(0, 400) } : {}),
          enabled: isSkillEnabled(String(c.id || c.name).replace(/^\/?skill:/, ''), c.source?.path || c.source?.filePath, overrides),
          source: c.source?.filePath && getActiveAgentDir() && !c.source.filePath.startsWith(getActiveAgentDir()) ? ('project' as const) : ('global' as const),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    async setSkillEnabled(name: string, on: boolean): Promise<boolean> {
      const overrides = setSkillEnabledInGlobal(name, undefined, on)
      return overrides[name] !== false
    },

    async listExtensions(): Promise<Array<{ name: string; version?: string; loaded: boolean }>> {
      await awaitWslVm()
      const probes: ExtensionProbeResult[] = []
      for (const project of trustedProjects()) {
        try {
          probes.push(...(await probeExtensionsShared(project)))
        } catch {
          /* advisory only */
        }
      }
      const seen = new Map<string, { name: string; version?: string; loaded: boolean }>()
      for (const p of probes) {
        if (!p.name || seen.has(p.id)) continue
        seen.set(p.id, { name: p.name, ...(p.version ? { version: p.version } : {}), loaded: p.runtimeLoaded === true || p.enabled === true })
      }
      return [...seen.values()].slice(0, 200)
    },

    hostStatus(): { appVersion: string; platform: string; sdkVersion: string; sdkPath?: string; ownerProtocol?: number } {
      const active = resolveActiveSdk(app.getPath('userData'), { skipSpawn: true })
      return {
        appVersion: app.getVersion(),
        platform: `${process.platform}-${process.arch}`,
        sdkVersion: active.version || readBuiltinSdkVersion(),
        ...(active.kind !== 'builtin' ? { sdkPath: active.entryPath } : {}),
      }
    },

    // Remote PTY lane: dedicated bridge so its output routes only back through the
    // gateway connection that opened the terminal (never the renderer channels).
    terminalOpen(projectId: string, opts: { cols: number; rows: number }, handlers: { data(id: string, data: string): void; exit(id: string, code: number): void }): string {
      return remoteTerminals.open(projectId, opts, handlers)
    },
    terminalWrite(id: string, data: string): void {
      remoteTerminals.write(id, data)
    },
    terminalResize(id: string, cols: number, rows: number): void {
      remoteTerminals.resize(id, cols, rows)
    },
    terminalClose(id: string): void {
      remoteTerminals.close(id)
    },

    capabilityCatalog,
    sessionCapabilities: (sessionFile) => normalizeCapabilities(configStore.get('sessionCapabilities')?.[normalizeSessionFileKey(sessionFile)]),
    setSessionCapabilities(sessionFile: string, ids: string[]): void {
      const key = normalizeSessionFileKey(sessionFile)
      const all = { ...(configStore.get('sessionCapabilities') || {}) }
      const caps = normalizeCapabilities(ids)
      delete all[key]
      if (caps.length) all[key] = caps
      configStore.set('sessionCapabilities', Object.fromEntries(Object.entries(all).slice(-MAX_REMEMBERED_CAPABILITIES)))
    },

    async getCacheWarming(): Promise<CacheWarming> {
      const r = await invokeHandler<{ settings?: { cacheWarming?: string } | null }>('ipc:pi.settings.get')
      const v = r.settings?.cacheWarming
      return v === 'off' || v === 'idle' || v === 'streaming' ? v : 'streaming'
    },

    async setCacheWarming(mode: CacheWarming): Promise<CacheWarming> {
      const r = await invokeHandler<{ ok?: boolean; error?: string }>('ipc:pi.settings.set', { patch: { cacheWarming: mode } })
      if (r.ok === false) throw new Error(r.error || 'pi_settings_write_failed')
      return mode
    },

    notifySessionsChanged(projectId) {
      void sessionPreviewProcess.invalidateListSessions(projectId).catch(() => {})
      sendToRenderer('ipc:events', { type: 'remote-settings-changed', key: 'sessions', workspaceId: projectId })
    },

    notifySettingsChanged(key, sessionFile) {
      sendToRenderer('ipc:events', { type: 'remote-settings-changed', key, ...(sessionFile ? { sessionFile } : {}) })
    },

    toolCardFor: (toolName, projectId) => findAdapterByTool(toolName, projectId)?.toolCard,

    storage: {
      get: (key) => configStore.get(key as 'remote'),
      set: (key, value) => configStore.set(key as 'remote', value as never),
    },

    // safeStorage when the OS keyring works. Without one (common on Linux dev boxes) the host key
    // goes to a 0600 file in userData, like an ssh key: an in-memory key would change on every
    // restart and force every phone to scan the QR code again.
    secrets: {
      available: () => true,
      seal: (plain) => {
        if (safeStorageAvailable()) return safeStorage.encryptString(plain).toString('base64')
        const file = join(app.getPath('userData'), HOST_KEY_FILE)
        writeFileSync(file, plain, { mode: 0o600 })
        chmodSync(file, 0o600)
        return HOST_KEY_FILE_MARK
      },
      open: (sealed) => {
        try {
          if (sealed === HOST_KEY_FILE_MARK) return readFileSync(join(app.getPath('userData'), HOST_KEY_FILE), 'utf8').trim() || null
          return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
        } catch {
          return null
        }
      },
    },

    assetPath(name: string): string | null {
      if (name !== 'mermaid.min.js') return null
      try {
        return createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js')
      } catch {
        return null
      }
    },

    log(level, message) {
      if (level === 'error') console.error(message)
      else if (level === 'warn') console.warn(message)
      else console.log(message)
    },
  }
}
