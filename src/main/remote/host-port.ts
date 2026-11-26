import type { TreeRow } from './branches'
import type { AppEvent } from '@shared/app-events'
import type { CapabilityInfo } from '@shared/capabilities'
import type { CacheWarming, CommandInfo, ContextStats, FileEntry, UiRequest, UiResponse, SessionUsage } from '@shared/remote'
import type { ToolCardDef } from '../../extension-compat/adapter-schema'

/**
 * Everything the remote gateway needs from the desktop. The gateway never touches Electron,
 * workerManager or config directly — only this port — so it runs under tests with a fake and
 * could later run headless. The Electron implementation lives in `src/main/remote-host-electron.ts`.
 *
 * Hard rule for implementations: nothing here may change the desktop's foreground session,
 * pending bind or current workspace (no `session.open` / `setPendingBind` / `workspace.switch`).
 */

export type HostSessionRow = {
  sessionFile: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  firstMessage?: string
  /** iss_20261121165413: set on the provisional announce row until the transcript file is disk-visible. */
  provisionalUntil?: number
}

/** Timeline row as produced by the worker / preview process (see src/worker/worker-timeline.ts). */
export type HostTimelineItem = {
  id: string
  type: string
  text?: string
  thinkingText?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolOutput?: string
  toolDetails?: unknown
  isError?: boolean
  sessionEntryId?: string
  timestamp?: number
  incomplete?: boolean
  stopReason?: string
}

export type HostSessionHistory = {
  items: HostTimelineItem[]
  model?: string
  thinking?: string
}

export type HostLiveState = {
  running: boolean
  model?: string
  thinking?: string
  availableThinking?: string[]
}

export type HostModelList = {
  models: Array<{ id: string; name?: string; provider?: string; group?: 'custom' | 'apiKey' | 'login' }>
  current?: string
  thinking?: string
  availableThinking: string[]
}

export type SendMode = 'prompt' | 'steer' | 'followUp'

export interface RemoteHostPort {
  hostName(): string
  appVersion(): string

  /** Projects the desktop trusts (recent projects). The gateway intersects them with its whitelist. */
  trustedProjects(): string[]
  /** Display info for a project folder: temporary chats live in sandbox dirs named by a random id. */
  projectInfo?(path: string): { label?: string; temporary?: boolean }
  listSessions(projectId: string): Promise<HostSessionRow[]>
  /** Workspace the session belongs to (header cwd), or null when unknown / unreadable. */
  sessionProject(sessionFile: string): Promise<string | null>
  /** Disk-first history for an authorized session; never spawns a worker. */
  readHistory(projectId: string, sessionFile: string): Promise<HostSessionHistory>
  liveState(sessionFile: string): Promise<HostLiveState>

  /** `projectId` is the session's (whitelisted) workspace: the cwd fallback when its file has no header yet. */
  send(sessionFile: string, text: string, mode: SendMode, capabilities: string[], projectId: string): Promise<void>
  /** Truthful abort: `stopped` is only true when the owned run actually stopped; never spawn a worker. */
  abort(sessionFile: string): Promise<{ wasRunning: boolean; stopped: boolean }>
  /**
   * Move the session's leaf to just before the user entry `anchor` (desktop rewind). Binds the
   * session's own worker (cwd `projectId`) when it has none; returns the rewound message text.
   */
  rewind(sessionFile: string, anchor: string, projectId: string): Promise<{ editorText?: string }>
  /** Empty the session's steer/follow-up queue and return the texts (steering first); [] without a live worker. */
  clearQueue(sessionFile: string): Promise<string[]>
  /** New session in the background: never reuses or replaces the desktop's foreground worker. */
  /** The session's entry tree and current leaf (desktop session tree). */
  sessionTree(sessionFile: string, projectId: string): Promise<{ rows: TreeRow[]; leafId: string | null }>
  /** Move the session's leaf to `leafId` (another branch's last entry) on its own worker. */
  switchBranch(sessionFile: string, leafId: string, projectId: string): Promise<void>
  /** Fork before the user entry `anchor` into a new session file of the same project. */
  fork(sessionFile: string, anchor: string, projectId: string): Promise<{ sessionFile: string; editorText?: string }>
  createSession(projectId: string): Promise<string>
  listModels(sessionFile: string): Promise<HostModelList>
  setModel(sessionFile: string, modelId: string): Promise<string>
  setThinking(sessionFile: string, level: string): Promise<void>
  /** Store a phone attachment where prompt paths can reference it (desktop clipboard-image dir). */
  saveAttachment(bytes: Uint8Array, name: string, mime: string): Promise<string>
  /** Bytes of a stored attachment, or null when `path` is not a `pi-clipboard-*` file in the attachment dir. */
  readAttachment(path: string): Promise<{ bytes: Uint8Array; mime: string } | null>

  respondUi(response: UiResponse): void
  cancelUi(id: string): void
  /** Close a dialog the desktop is showing because a remote client answered it. */
  dismissDesktopUi(id: string): void

  /** Slash commands for a project folder, from disk and extension probes (never spawns or touches a worker). */
  listCommands(projectId: string): Promise<CommandInfo[]>
  /** Context usage of a session (live worker first, disk otherwise); null when unreadable. */
  contextStats(sessionFile: string, projectId: string): Promise<ContextStats | null>
  /** Summed `usage` of the session file's replies (phone session panel). */
  sessionUsage(sessionFile: string): Promise<SessionUsage | null>
  /** A folder under the project root, or null when `path` escapes it / is not a folder. */
  /** The project's working tree against HEAD as `git diff` text (incl. untracked text files). */
  gitDiff(projectId: string): Promise<{ isRepo: boolean; branch: string; raw: string; message?: string }>
  listDir(projectId: string, path: string, dotfiles: boolean): Promise<{ entries: FileEntry[]; truncated: boolean } | null>
  searchFiles(projectId: string, query: string): Promise<FileEntry[]>
  /** Bounded text preview of a project file (realpath-contained; binary refused). */
  readFilePreview(projectId: string, path: string): Promise<{ content: string; size: number; truncated: boolean; mime: string } | null>
  /** Create an empty file/folder inside the project; never overwrites. Returns the canonical rel path. */
  createFile(projectId: string, path: string, dir?: boolean): Promise<string>
  /** Rename within the current folder (name only). Returns the new rel path. */
  renameFile(projectId: string, path: string, newName: string): Promise<string>
  /** Rename a session (title). Throws the typed owner conflict when an external writer owns it. */
  renameSession(sessionFile: string, title: string, projectId: string): Promise<string>
  /** Delete a session file (host moves it aside first when a worker is live). */
  deleteSession(sessionFile: string, projectId: string): Promise<void>
  /** Clone a session to a new independent file (pi `clone`). Returns the new session file. */
  cloneSession(sessionFile: string, projectId: string): Promise<string>
  /** Skills catalog for a project (names + enabled state only). */
  listSkills(projectId: string): Promise<Array<{ name: string; description?: string; enabled: boolean; source?: 'global' | 'project' }>>
  setSkillEnabled(name: string, on: boolean): Promise<boolean>
  /** Installed extensions inventory (names/versions/status only — never config values). */
  listExtensions(): Promise<Array<{ name: string; version?: string; loaded: boolean }>>
  /** Host versions (masked: no credentials, no agent-dir paths beyond the SDK entry). */
  hostStatus(): { appVersion: string; platform: string; sdkVersion: string; sdkPath?: string; ownerProtocol?: number }
  /** Tailscale Serve hostname the owner configured (read-only; activation is a separate release gate), or null. */
  serveConfig?(): string | null
  /**
   * Bearer token for the local admin control plane (`/admin/v1/*` in `gateway.ts`). Implementations
   * keep it in a 0600 file next to the host key (userData); the gateway only ever sees the token
   * through this accessor, never a filesystem path. Optional: adapters without it keep admin routes
   * fail-closed (403).
   */
  adminToken?(): string
  /** Open a host PTY in `projectId`; output/exit arrive through `handlers` (remote gateway lane only). */
  terminalOpen(projectId: string, opts: { cols: number; rows: number }, handlers: { data(id: string, data: string): void; exit(id: string, code: number): void }): string
  terminalWrite(id: string, data: string): void
  terminalResize(id: string, cols: number, rows: number): void
  terminalClose(id: string): void
  capabilityCatalog(): CapabilityInfo[]
  sessionCapabilities(sessionFile: string): string[]
  setSessionCapabilities(sessionFile: string, ids: string[]): void
  getCacheWarming(): Promise<CacheWarming>
  setCacheWarming(mode: CacheWarming): Promise<CacheWarming>
  /** Tell the desktop renderer a setting changed underneath it. */
  notifySettingsChanged(key: 'cacheWarming' | 'capabilities' | 'rewound', sessionFile?: string): void
  /** A remotely created session now exists on disk: the desktop sidebar should re-list this project. */
  notifySessionsChanged(projectId: string): void

  toolCardFor(toolName: string, projectId: string): ToolCardDef | undefined

  storage: { get(key: string): unknown; set(key: string, value: unknown): void }
  secrets: { available(): boolean; seal(plain: string): string; open(sealed: string): string | null }
  /** Absolute path of a whitelisted static asset (e.g. mermaid.min.js), or null. */
  assetPath(name: string): string | null
  log(level: 'info' | 'warn' | 'error', message: string): void
}

/** Events the desktop pushes into the gateway (see `tap.ts`). */
export type RemoteTapSink = {
  appEvent(event: AppEvent): void
  uiRequest(request: UiRequest): void
  uiResolved(id: string, by: 'desktop' | 'remote' | 'system'): void
  settingsChanged(key: 'cacheWarming' | 'capabilities', sessionFile?: string): void
}
