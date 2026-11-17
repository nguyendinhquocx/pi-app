import { ATTACHMENT_MAX_BYTES, REMOTE_METHODS, encodeWebPairLink, isRemoteMethod, roleAllows, type MethodParams, type MethodResult, type RemoteMethod, type Role } from '@shared/remote'
import { normalizeSessionFileKey } from '@shared/session-file-key'
import type { AssetInfo } from './assets'
import { RpcFail } from './errors'
import type { RemoteHostPort } from './host-port'
import { WorkerOwnerConflictError } from '../worker-owner-conflict'
import type { HubClient, SessionHub } from './session-hub'
import type { UiRouter } from './ui-router'

/** Folder listings beyond this are cut (the phone shows a search hint instead). */
const FILE_LIST_MAX = 1000

/** Per-connection identity established by the handshake. */
export type RpcCaller = HubClient & {
  deviceId: string
  role: () => Role
}

export type RpcContext = {
  port: RemoteHostPort
  hub: SessionHub
  ui: UiRouter
  hostId: () => string
  assets: () => AssetInfo[]
  features: string[]
  endpoints?: () => string[]
  /** Owner protocol version the host SDK enforces (absent on pre-T1 builds). */
  ownerProtocol?: () => number | null
  /** Browser pair link (https://li.quoc.app/#pair=…) for the current pairing, if any. */
  webPairLink?: () => string | null
}

/** Per-connection remote terminals: only the opener drives them; closed on disconnect. */
export type RemoteTerminalEntry = { connId: string; close(): void }

type Handler<M extends RemoteMethod> = (caller: RpcCaller, params: MethodParams<M>) => Promise<MethodResult<M>>
type HandlerTable = { [M in RemoteMethod]: Handler<M> }

const SEND_DEDUPE_MAX = 500

/**
 * Method dispatch: schema validation → role check → handler. Handlers only talk to the hub,
 * UI router and host port. `turn.send` is idempotent per clientMessageId for the process lifetime.
 */
export class RemoteRpc {
  private readonly sent = new Map<string, Promise<MethodResult<'turn.send'>>>()
  private readonly terminals = new Map<string, RemoteTerminalEntry>()
  private readonly handlers: HandlerTable

  constructor(private readonly ctx: RpcContext) {
    const { port, hub, ui } = ctx
    this.handlers = {
      'host.hello': async (caller) => ({
        hostId: ctx.hostId(),
        hostName: port.hostName(),
        version: port.appVersion(),
        epoch: hub.epoch,
        deviceId: caller.deviceId,
        role: caller.role(),
        features: ctx.features,
        assets: ctx.assets(),
        ...(ctx.endpoints ? { endpoints: ctx.endpoints() } : {}),
        ...(ctx.ownerProtocol?.() ? { ownerProtocol: ctx.ownerProtocol()! } : {}),
        ...(ctx.webPairLink?.() ? { webPairLink: ctx.webPairLink()! } : {}),
      }),
      'project.list': async () => ({
        projects: port
          .trustedProjects()
          .filter((p) => hub.isAllowedProject(p))
          .map((id) => {
            const info = port.projectInfo?.(id) ?? {}
            const folder = id.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || id
            return { id, name: info.label || folder, ...(info.temporary ? { temporary: true } : {}) }
          })
          // Temporary chats after real projects.
          .sort((a, b) => Number(!!a.temporary) - Number(!!b.temporary)),
      }),
      'session.watchList': async (caller, p) => ({ sessions: await hub.watchList(caller, p.projectId) }),
      'session.unwatchList': async (caller) => {
        hub.unwatchList(caller)
        return {}
      },
      'session.open': async (caller, p) => hub.open(caller, p.sessionKey, p.cursor),
      'session.close': async (caller, p) => {
        hub.close(caller, p.sessionKey)
        return {}
      },
      'turn.page': async (_c, p) => hub.page(p.sessionKey, p.before, p.limit),
      'turn.toolDetail': async (_c, p) => hub.toolDetail(p.sessionKey, p.toolCallId),
      'turn.send': async (_c, p) => {
        const prior = this.sent.get(p.clientMessageId)
        if (prior) return prior.then((r) => ({ ...r, duplicate: true }))
        const run = (async () => {
          const { entry, projectId } = await hub.authorize(p.sessionKey)
          await port.send(entry.sessionFile, p.text, p.mode, port.sessionCapabilities(entry.sessionFile), projectId)
          return { accepted: true as const }
        })()
        this.sent.set(p.clientMessageId, run)
        if (this.sent.size > SEND_DEDUPE_MAX) this.sent.delete(this.sent.keys().next().value as string)
        // A failed send may be retried with the same id.
        run.catch(() => this.sent.delete(p.clientMessageId))
        return run
      },
      'turn.abort': async (_c, p) => {
        const { entry } = await hub.authorize(p.sessionKey)
        // The worker's abort drops its queue: take the texts first so they are not lost.
        const restored = await port.clearQueue(entry.sessionFile).catch(() => [])
        const r = await port.abort(entry.sessionFile)
        // Truthful: `aborted` is only true when a run was running and actually stopped.
        const aborted = r.wasRunning && r.stopped
        return { aborted, wasRunning: r.wasRunning, stopped: r.stopped, restored }
      },
      'turn.rewind': async (_c, p) => hub.rewind(p.sessionKey, p.anchor),
      'session.branches': async (_c, p) => hub.branches(p.sessionKey),
      'session.switchBranch': async (_c, p) => hub.switchBranch(p.sessionKey, p.leafId),
      'session.fork': async (_c, p) => hub.fork(p.sessionKey, p.anchor),
      'turn.dequeue': async (_c, p) => {
        const { entry } = await hub.authorize(p.sessionKey)
        return { restored: await port.clearQueue(entry.sessionFile) }
      },
      'session.create': async (_c, p) => {
        if (!hub.isAllowedProject(p.projectId)) throw new RpcFail('forbidden', 'project is not allowed')
        const project = port.trustedProjects().find((t) => normalizeSessionFileKey(t) === normalizeSessionFileKey(p.projectId)) ?? p.projectId
        const sessionFile = await port.createSession(project)
        if (p.capabilities?.length) {
          const known = new Set(port.capabilityCatalog().map((c) => c.id as string))
          port.setSessionCapabilities(sessionFile, p.capabilities.filter((c) => known.has(c)))
        }
        hub.announceSession(sessionFile, project)
        return { sessionKey: normalizeSessionFileKey(sessionFile) }
      },
      'model.list': async (_c, p) => {
        const { entry } = await hub.authorize(p.sessionKey)
        return port.listModels(entry.sessionFile)
      },
      'model.set': async (_c, p) => {
        const { entry } = await hub.authorize(p.sessionKey)
        return { model: await port.setModel(entry.sessionFile, p.modelId) }
      },
      'attachment.upload': async (_c, p) => {
        const bytes = Buffer.from(p.data, 'base64')
        if (!bytes.length) throw new RpcFail('bad_request', 'empty attachment')
        if (bytes.length > ATTACHMENT_MAX_BYTES) throw new RpcFail('bad_request', 'attachment too large')
        const path = await port.saveAttachment(bytes, p.name, p.mime)
        return { path, name: p.name, size: bytes.length }
      },
      'attachment.get': async (_c, p) => {
        const file = await port.readAttachment(p.path)
        if (!file) throw new RpcFail('not_found', 'attachment not found')
        if (file.bytes.length > ATTACHMENT_MAX_BYTES) throw new RpcFail('bad_request', 'attachment too large')
        return { mime: file.mime, data: Buffer.from(file.bytes).toString('base64') }
      },
      'thinking.set': async (_c, p) => {
        const { entry } = await hub.authorize(p.sessionKey)
        await port.setThinking(entry.sessionFile, p.level)
        return { level: p.level }
      },
      'session.stats': async (_c, p) => {
        const { entry, projectId } = await hub.authorize(p.sessionKey)
        const [context, usage] = await Promise.all([port.contextStats(entry.sessionFile, projectId).catch(() => null), port.sessionUsage(entry.sessionFile).catch(() => null)])
        return { context, usage }
      },
      'command.list': async (_c, p) => {
        const { projectId } = await hub.authorize(p.sessionKey)
        const commands = await port.listCommands(projectId)
        return { commands: commands.map((c) => ({ ...c, description: c.description?.slice(0, 400) })) }
      },
      'review.diff': async (_c, p) => hub.reviewDiff(p.sessionKey, p.scope, p.turnId, p.path),
      'file.list': async (_c, p) => {
        const { projectId } = await hub.authorize(p.sessionKey)
        const r = await port.listDir(projectId, p.path || '.', p.dotfiles === true)
        if (!r) throw new RpcFail('not_found', 'folder not found in the project')
        return { entries: r.entries.slice(0, FILE_LIST_MAX), truncated: r.truncated || r.entries.length > FILE_LIST_MAX }
      },
      'file.search': async (_c, p) => {
        const { projectId } = await hub.authorize(p.sessionKey)
        return { entries: (await port.searchFiles(projectId, p.query)).slice(0, 60) }
      },
      'capability.list': async (_c, p) => {
        const { entry } = await hub.authorize(p.sessionKey)
        const on = new Set(port.sessionCapabilities(entry.sessionFile))
        return {
          capabilities: port.capabilityCatalog().map((c) => ({
            id: c.id,
            available: c.available,
            ...(c.reason ? { reason: c.reason } : {}),
            promptTokens: c.promptTokens,
            tools: c.tools,
            enabled: on.has(c.id),
          })),
        }
      },
      'capability.set': async (_c, p) => {
        const { entry } = await hub.authorize(p.sessionKey)
        if (!port.capabilityCatalog().some((c) => c.id === p.id)) throw new RpcFail('bad_request', 'unknown capability')
        const current = port.sessionCapabilities(entry.sessionFile)
        const next = p.on ? [...new Set([...current, p.id])] : current.filter((c) => c !== p.id)
        port.setSessionCapabilities(entry.sessionFile, next)
        port.notifySettingsChanged('capabilities', entry.sessionFile)
        return { enabled: next }
      },
      'settings.cacheWarming.get': async () => ({ mode: await port.getCacheWarming() }),
      'settings.cacheWarming.set': async (_c, p) => {
        const mode = await port.setCacheWarming(p.mode)
        port.notifySettingsChanged('cacheWarming')
        return { mode }
      },
      'session.rename': async (_c, p) => {
        const { entry, projectId } = await hub.authorize(p.sessionKey)
        const title = await port.renameSession(entry.sessionFile, p.title, projectId)
        port.notifySessionsChanged(projectId)
        return { title }
      },
      'session.delete': async (_c, p) => {
        const { entry, projectId } = await hub.authorize(p.sessionKey)
        await port.deleteSession(entry.sessionFile, projectId)
        port.notifySessionsChanged(projectId)
        return { deleted: true }
      },
      'session.clone': async (_c, p) => {
        const { entry, projectId } = await hub.authorize(p.sessionKey)
        if (entry.projector.sessionState.running) throw new RpcFail('busy', 'stop the run before cloning')
        const file = await port.cloneSession(entry.sessionFile, projectId)
        hub.announceSession(file, projectId)
        return { sessionKey: normalizeSessionFileKey(file) }
      },
      'file.read': async (_c, p) => {
        const { projectId } = await hub.authorize(p.sessionKey)
        const r = await port.readFilePreview(projectId, p.path)
        if (!r) throw new RpcFail('not_found', 'file not found in the project')
        return r
      },
      'file.create': async (_c, p) => {
        const { projectId } = await hub.authorize(p.sessionKey)
        const path = await port.createFile(projectId, p.path, p.dir === true)
        return { path }
      },
      'file.rename': async (_c, p) => {
        const { projectId } = await hub.authorize(p.sessionKey)
        const path = await port.renameFile(projectId, p.path, p.newName)
        return { path }
      },
      'terminal.open': async (caller, p) => {
        const { projectId } = await hub.authorize(p.sessionKey)
        const id = port.terminalOpen(projectId, { cols: p.cols ?? 120, rows: p.rows ?? 30 }, {
          data: (tid, data) => {
            const conn = this.connById(caller, tid)
            if (conn) conn.sendEvent('terminal.data', { terminalId: tid, data })
          },
          exit: (tid, code) => {
            this.terminals.get(tid)?.close()
            this.terminals.delete(tid)
            const conn = this.connById(caller, tid)
            if (conn) conn.sendEvent('terminal.exit', { terminalId: tid, code })
          },
        })
        this.terminals.set(id, {
          connId: caller.id,
          close: () => port.terminalClose(id),
        })
        return { terminalId: id }
      },
      'terminal.input': async (caller, p) => {
        this.assertTerminalOwner(caller, p.terminalId)
        port.terminalWrite(p.terminalId, p.data)
        return {}
      },
      'terminal.resize': async (caller, p) => {
        this.assertTerminalOwner(caller, p.terminalId)
        port.terminalResize(p.terminalId, p.cols, p.rows)
        return {}
      },
      'terminal.close': async (caller, p) => {
        this.assertTerminalOwner(caller, p.terminalId)
        const t = this.terminals.get(p.terminalId)
        t?.close()
        this.terminals.delete(p.terminalId)
        return {}
      },
      'host.status': async () => {
        const st = port.hostStatus()
        const serve = port.serveConfig?.()
        return {
          appVersion: st.appVersion,
          platform: st.platform,
          sdkVersion: st.sdkVersion,
          ...(st.sdkPath ? { sdkPath: st.sdkPath } : {}),
          ...(st.ownerProtocol ? { ownerProtocol: st.ownerProtocol } : {}),
          ...(serve ? { serve: { configured: true, hostname: serve } } : {}),
        }
      },
      'skills.list': async (_c, p) => {
        const { projectId } = await hub.authorize(p.sessionKey)
        return { skills: await port.listSkills(projectId) }
      },
      'skills.setEnabled': async (_c, p) => {
        const enabled = await port.setSkillEnabled(p.name, p.on)
        return { enabled }
      },
      'extensions.list': async () => ({ extensions: await port.listExtensions() }),
      'ui.respond': async (_c, p) => ({ accepted: ui.respond(p) }),
      'ui.cancel': async (_c, p) => ({ accepted: ui.cancel(p.id) }),
    }
  }

  /** The connection that opened `terminalId` — events only ever go back to that connection. */
  private connById(caller: RpcCaller, terminalId: string): RpcCaller | null {
    const t = this.terminals.get(terminalId)
    if (!t || t.connId !== caller.id) return null
    return caller
  }

  /** Terminal control is owner-only: a viewer connection cannot drive another connection's PTY. */
  private assertTerminalOwner(caller: RpcCaller, terminalId: string): void {
    const t = this.terminals.get(terminalId)
    if (!t) throw new RpcFail('not_found', 'terminal not found')
    if (t.connId !== caller.id) throw new RpcFail('forbidden', 'terminal belongs to another connection')
  }

  /** Connection gone: kill its terminals so no host PTY outlives its client. */
  detachTerminals(connId: string): void {
    for (const [id, t] of this.terminals) {
      if (t.connId === connId) {
        t.close()
        this.terminals.delete(id)
      }
    }
  }

  async dispatch(caller: RpcCaller, method: string, rawParams: unknown): Promise<unknown> {
    if (!isRemoteMethod(method)) throw new RpcFail('not_supported', `unknown method ${method}`)
    const def = REMOTE_METHODS[method]
    if (!roleAllows(caller.role(), def.role)) throw new RpcFail('forbidden', 'this device is read-only')
    const parsed = def.params.safeParse(rawParams ?? {})
    if (!parsed.success) throw new RpcFail('bad_request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    const handler = this.handlers[method] as Handler<typeof method>
    try {
      return await handler(caller, parsed.data as never)
    } catch (error) {
      // Owner-protocol failures surface as typed codes, not generic internal errors.
      if (error instanceof WorkerOwnerConflictError) {
        throw new RpcFail(error.code, error.message, error.code === 'owner_unavailable')
      }
      throw error
    }
  }
}
