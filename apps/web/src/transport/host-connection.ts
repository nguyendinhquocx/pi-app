import { parseFrame, makeReq, makePing, makePong, type Frame, type RpcError, type Role } from '@shared/remote'
import { REMOTE_EVENTS, REMOTE_METHODS, type RemoteEvent, type EventPayload, type RemoteMethod, type MethodParams, type MethodResult } from '@shared/remote'
import type { ZodTypeAny } from 'zod'
import { prepareHs1, type HandshakeOutcome } from './handshake'
import { ReconnectBackoff, type BackoffOptions } from './reconnect'
import type { DeviceKeyRecord } from './device-keys'
import { normalizeUnknownCustomUiRequest } from './web-ui-request'

/**
 * One host connection from the browser PWA (spec T3).
 *
 * Lifecycle: CONNECTING → HANDSHAKING → ONLINE → (drop) → backoff → CONNECTING…
 * - Typed RPC via `REMOTE_METHODS` schemas; every call is scoped to this host instance, so host
 *   identity is never ambiguous across connections.
 * - Server events dispatch typed via `REMOTE_EVENTS`.
 * - Keepalive ping every 30s (host idle timeout is 75s).
 * - Reconnect: exponential backoff + jitter; after a successful handshake every watched session
 *   is re-opened with its last cursor; `resync: epoch_changed` surfaces as onResync so the UI
 *   reloads the snapshot (forced resync, spec envelope contract).
 * - No queued writes when delivery is ambiguous: calling an RPC while offline rejects
 *   immediately with a DisconnectedError; nothing is buffered.
 */

export type ConnState = 'idle' | 'connecting' | 'handshaking' | 'online' | 'reconnecting' | 'closed' | 'error'

export class DisconnectedError extends Error {
  readonly code = 'disconnected'
  constructor(message = 'host connection is not online') {
    super(message)
    this.name = 'DisconnectedError'
  }
}

export class RpcRejectedError extends Error {
  constructor(
    readonly rpcError: RpcError,
    readonly method: string,
  ) {
    super(`${method} failed: ${rpcError.code} ${rpcError.message}`)
    this.name = 'RpcRejectedError'
  }
}

export type HostConnectionEvents = {
  onState?: (state: ConnState, detail?: string) => void
  onEvent?: (event: RemoteEvent, payload: EventPayload<RemoteEvent>) => void
  onResync?: (sessionKey: string, reason: NonNullable<import('@shared/remote').OpenResult['resync']>) => void
  onHello?: (hello: MethodResult<'host.hello'>) => void
  /** RPC snapshot/replay result: needed because session.open is a response, not an event. */
  onSessionOpen?: (sessionKey: string, result: MethodResult<'session.open'>) => void
  /** Session is no longer watched; cancel any client-side resync state for it. */
  onSessionClosed?: (sessionKey: string) => void
}

export type SocketLike = {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void
  close(code?: number, reason?: string): void
  readonly readyState: number
}

/** Event-handler surface shared by the browser WebSocket and the test FakeSocket. */
type SocketHandlers = {
  onopen: (() => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onclose: ((ev: CloseEvent) => void) | null
  onerror: (() => void) | null
}

export type HostConnectionOptions = {
  endpoint: string
  device: DeviceKeyRecord
  /** Pair token only for the first pairing; absent for established keys. */
  pairToken?: string
  socketFactory?: (url: string) => SocketLike
  backoff?: BackoffOptions
  pingIntervalMs?: number
  requestTimeoutMs?: number
  /** turn.send may cold-start a host worker; give it room beyond the host's 60s init cap. */
  turnSendTimeoutMs?: number
  /** Re-open watched sessions after reconnect. Default true. */
  resumeSessions?: boolean
  events?: HostConnectionEvents
}

/** Events the connection re-opens automatically after a reconnect. */
type WatchedSession = { sessionKey: string; cursor?: { epoch: string; seq: number } }

const PING_INTERVAL = 30_000
const REQUEST_TIMEOUT = 20_000
// Cold worker initialization is bounded at 60s on LiX; leave 30s for transport/dispatch overhead.
// session.create also spawns a worker: same ceiling + headroom (GLM R4: 60s left no margin).
const TURN_SEND_TIMEOUT = 90_000
const SESSION_CREATE_TIMEOUT = 90_000
/** Per-method timeout overrides; anything else uses the generic request timeout. */
const METHOD_TIMEOUTS: Partial<Record<string, number>> = {
  'turn.send': TURN_SEND_TIMEOUT,
  'session.create': SESSION_CREATE_TIMEOUT,
}

export class HostConnection {
  readonly hostId: string
  state: ConnState = 'idle'
  role: Role | null = null
  hello: MethodResult<'host.hello'> | null = null

  private ws: SocketLike | null = null
  private channel: import('@shared/remote/crypto').SecureChannel | null = null
  private readonly opts: HostConnectionOptions & {
    pingIntervalMs: number
    requestTimeoutMs: number
    turnSendTimeoutMs: number
    resumeSessions: boolean
  }
  private readonly backoff: ReconnectBackoff
  private reqId = 0
  private pending = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }>()
  private watched = new Map<string, WatchedSession>()
  private openRequestSequence = 0
  private readonly openRequests = new Map<string, number>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimeout: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private lastError: string | null = null
  private events: HostConnectionEvents
  private readonly eventSubscribers = new Set<(event: RemoteEvent, payload: EventPayload<RemoteEvent>) => void>()
  private readonly stateSubscribers = new Set<(state: ConnState, detail?: string) => void>()
  private pendingPairToken?: string

  constructor(options: HostConnectionOptions) {
    this.hostId = options.device.hostId
    this.opts = {
      pingIntervalMs: PING_INTERVAL,
      requestTimeoutMs: REQUEST_TIMEOUT,
      turnSendTimeoutMs: TURN_SEND_TIMEOUT,
      resumeSessions: true,
      ...options,
    }
    this.backoff = new ReconnectBackoff(options.backoff ?? {})
    this.events = options.events ?? {}
    this.pendingPairToken = options.pairToken
  }

  get online(): boolean {
    return this.state === 'online' && this.channel !== null
  }

  get errorDetail(): string | null {
    return this.lastError
  }

  /** Begin connecting (idempotent). */
  start(): void {
    if (this.stopped) return
    if (this.state !== 'idle' && this.state !== 'reconnecting' && this.state !== 'error') return
    if (this.state === 'error') this.backoff.reset()
    this.setState('connecting')
    const ws = (this.opts.socketFactory ?? ((url: string) => new WebSocket(url)))(this.opts.endpoint)
    // Browser WebSockets deliver binary frames as Blob by default; the host only ever sends
    // encrypted binary frames after hs2, so arrays are required (HostSim/Node hides this —
    // Node's ws client already yields buffers, which is why tests never caught it, spec T5).
    if (typeof WebSocket !== 'undefined' && 'binaryType' in ws) ws.binaryType = 'arraybuffer'
    this.ws = ws
    const handlers = ws as unknown as SocketHandlers
    handlers.onopen = () => this.onSocketOpen()
    handlers.onmessage = (ev) => void this.onSocketMessage(ev)
    handlers.onclose = (ev) => this.onSocketClose(`socket closed (${ev.code})`)
    handlers.onerror = () => this.onSocketClose('socket error')
  }

  /** Stop for good: no more reconnects, pending RPCs reject, socket closes. */
  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.failPending(new DisconnectedError('connection stopped'))
    this.setState('closed')
    try {
      this.ws?.close(1000, 'client stop')
    } catch {
      /* already gone */
    }
    this.ws = null
    this.channel = null
  }

  /** Forget volatile state (e.g. after the device key was deleted). */
  dispose(): void {
    this.stop()
    this.watched.clear()
    this.openRequests.clear()
    this.eventSubscribers.clear()
    this.stateSubscribers.clear()
  }

  /** Subscribe to host events without replacing the workbench's store listener (e.g. PTY output). */
  subscribeEvents(listener: (event: RemoteEvent, payload: EventPayload<RemoteEvent>) => void): () => void {
    this.eventSubscribers.add(listener)
    return () => this.eventSubscribers.delete(listener)
  }

  /** Connection-state signal for consumers that must wait for 'online' (remote terminal lane). */
  subscribeState(listener: (state: ConnState, detail?: string) => void): () => void {
    this.stateSubscribers.add(listener)
    listener(this.state)
    return () => this.stateSubscribers.delete(listener)
  }

  async request<M extends RemoteMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    if (!this.online || !this.channel) throw new DisconnectedError()
    const schema = REMOTE_METHODS[method]
    const id = `w${++this.reqId}`
    const frame = makeReq(id, method, schema.params.parse(params))
    // A per-connection turnSendTimeoutMs override wins for turn.send (option stays live);
    // otherwise the per-method map applies, falling back to the generic request timeout.
    const timeoutMs = (method === 'turn.send' ? this.opts.turnSendTimeoutMs : METHOD_TIMEOUTS[method]) ?? this.opts.requestTimeoutMs
    const promise = new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
    })
    this.sendEncrypted(frame)
    const res = await promise
    if (res.k === 'res' && res.ok) return schema.result.parse(res.p) as MethodResult<M>
    if (res.k === 'res') throw new RpcRejectedError(res.err, method)
    throw new Error(`unexpected frame kind for ${method}: ${res.k}`)
  }

  /**
   * Open a session and start watching it across reconnects. Cursor replay/resync handled here:
   * `resync: epoch_changed` (or gap/evicted) triggers onResync so the UI reloads the snapshot.
   */
  async openSession(sessionKey: string, cursor?: { epoch: string; seq: number }): Promise<MethodResult<'session.open'>> {
    return (await this.openSessionTracked(sessionKey, cursor)).result
  }

  /** The UI uses the freshness bit to avoid applying a late snapshot after a newer open. */
  async openSessionTracked(sessionKey: string, cursor?: { epoch: string; seq: number }): Promise<{ result: MethodResult<'session.open'>; current: boolean }> {
    const requestId = ++this.openRequestSequence
    this.openRequests.set(sessionKey, requestId)
    try {
      const result = await this.request('session.open', { sessionKey, ...(cursor ? { cursor } : {}) })
      if (this.openRequests.get(sessionKey) !== requestId) return { result, current: false }
      // The open response's seq is the replay/snapshot head. Preserve a newer live-event cursor
      // that arrived during the request, but never roll back to the cursor used to request replay.
      const snapshotCursor = { epoch: result.epoch, seq: result.seq }
      const eventCursor = this.watched.get(sessionKey)?.cursor
      const current: WatchedSession = {
        sessionKey,
        cursor: eventCursor?.epoch === result.epoch && eventCursor.seq > snapshotCursor.seq ? eventCursor : snapshotCursor,
      }
      this.watched.set(sessionKey, current)
      this.events.onSessionOpen?.(sessionKey, result)
      if (result.resync) this.events.onResync?.(sessionKey, result.resync)
      const stillCurrent = this.openRequests.get(sessionKey) === requestId
      if (stillCurrent) this.openRequests.delete(sessionKey)
      return { result, current: stillCurrent }
    } catch (error) {
      if (this.openRequests.get(sessionKey) === requestId) this.openRequests.delete(sessionKey)
      throw error
    }
  }

  /** Stop watching a session (also invalidates a late open response). */
  closeSession(sessionKey: string): Promise<MethodResult<'session.close'>> {
    this.watched.delete(sessionKey)
    this.openRequests.delete(sessionKey)
    this.events.onSessionClosed?.(sessionKey)
    return this.request('session.close', { sessionKey })
  }

  /** Forget a watched session without an RPC (local state only). */
  unwatch(sessionKey: string): void {
    this.watched.delete(sessionKey)
    this.openRequests.delete(sessionKey)
    this.events.onSessionClosed?.(sessionKey)
  }

  /** Whether any non-stale session.open request is still awaiting a result. */
  hasPendingOpen(sessionKey: string): boolean {
    return this.openRequests.has(sessionKey)
  }

  /** A store listener handles snapshots synchronously; standalone callers use the fallback. */
  hasSessionOpenListener(): boolean {
    return typeof this.events.onSessionOpen === 'function'
  }

  watchList(): string[] {
    return [...this.watched.keys()]
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Merge additional event listeners (workbench store wiring) without replacing connection-internal ones. */
  bindEvents(events: HostConnectionEvents): void {
    const prev = this.events
    this.events = {
      onState: (s, d) => {
        prev.onState?.(s, d)
        events.onState?.(s, d)
      },
      onEvent: (e, p) => {
        prev.onEvent?.(e, p)
        events.onEvent?.(e, p)
      },
      onResync: (k, r) => {
        prev.onResync?.(k, r)
        events.onResync?.(k, r)
      },
      onHello: (h) => {
        prev.onHello?.(h)
        events.onHello?.(h)
      },
      onSessionOpen: (k, r) => {
        prev.onSessionOpen?.(k, r)
        events.onSessionOpen?.(k, r)
      },
      onSessionClosed: (k) => {
        prev.onSessionClosed?.(k)
        events.onSessionClosed?.(k)
      },
    }
  }

  private setState(s: ConnState, detail?: string): void {
    const notify = (): void => { for (const cb of this.stateSubscribers) cb(s, detail) }
    if (this.state !== s) {
      this.state = s
      this.events.onState?.(s, detail)
      notify()
    } else if (detail) {
      this.events.onState?.(s, detail)
      notify()
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.handshakeTimeout) clearTimeout(this.handshakeTimeout)
    this.pingTimer = this.reconnectTimer = this.handshakeTimeout = null
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private onSocketOpen(): void {
    if (this.stopped) return
    this.setState('handshaking')
    this.handshakeTimeout = setTimeout(() => this.onSocketClose('handshake timeout'), 10_000)
    const prepared = prepareHs1({
      ws: this.ws as unknown as WebSocket,
      device: this.opts.device,
      hostPub: this.opts.device.hostPub,
      ...(this.pendingPairToken ? { pairToken: this.pendingPairToken } : {}),
    })
    // Install the finisher BEFORE the bytes hit the socket: a same-process host can answer
    // hs2 synchronously inside `send` (see prepareHs1 doc).
    this.finisher = prepared.finish
    this.ws?.send(JSON.stringify(prepared.msg))
  }

  private finisher: ((hs2: unknown) => HandshakeOutcome) | null = null

  private async onSocketMessage(ev: MessageEvent): Promise<void> {
    if (this.stopped || !this.ws) return
    // Handshake phase: plaintext JSON text frames (hs2 / hs_err).
    if (!this.channel) {
      if (typeof ev.data !== 'string') return
      let raw: unknown
      try {
        raw = JSON.parse(ev.data)
      } catch {
        return this.onSocketClose('bad handshake frame')
      }
      if (this.handshakeTimeout) clearTimeout(this.handshakeTimeout)
      this.handshakeTimeout = null
      const outcome = this.finisher?.(raw) ?? { ok: false as const, code: 'bad' as const }
      if (!outcome.ok) {
        const detail = outcome.code === 'hs_err' ? `handshake refused: ${outcome.code_detail}` : 'handshake failed (wrong host key?)'
        return this.onSocketClose(detail)
      }
      if (outcome.payload.hostId !== this.hostId) {
        return this.onSocketClose(`handshake host identity mismatch (expected ${this.hostId}, received ${outcome.payload.hostId})`)
      }
      this.channel = outcome.channel
      this.role = outcome.role
      // The host consumed/recognized the device key. A future reconnect no longer needs the
      // one-time pair token; never persist it beyond this in-memory first successful handshake.
      this.pendingPairToken = undefined
      this.backoff.reset()
      this.setState('online')
      this.startPing()
      await this.afterOnline()
      return
    }
    // Online phase: encrypted binary frames only.
    let bytes: Uint8Array
    if (typeof ev.data === 'string') return this.onSocketClose('plaintext after handshake')
    if (ev.data instanceof ArrayBuffer) bytes = new Uint8Array(ev.data)
    else if (ArrayBuffer.isView(ev.data)) bytes = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
    else return this.onSocketClose('unsupported frame type')
    let raw: unknown
    try {
      raw = this.channel.decrypt(bytes)
    } catch {
      return this.onSocketClose('decrypt failed')
    }
    const frame = parseFrame(raw)
    if (!frame) return this.onSocketClose('bad frame')
    if (frame.k === 'ping') return this.sendEncrypted(makePong(frame.id))
    if (frame.k === 'pong') return
    if (frame.k === 'res') {
      const p = this.pending.get(frame.id)
      if (p) {
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        p.resolve(frame)
      }
      return
    }
    if (frame.k === 'evt') this.dispatchEvt(frame)
  }

  private dispatchEvt(frame: Extract<Frame, { k: 'evt' }>): void {
    const name = frame.m as RemoteEvent
    const def = REMOTE_EVENTS[name]
    if (!def) return
    const parsed = (def as ZodTypeAny).safeParse(frame.p)
    if (!parsed.success) {
      // Unknown extension custom UI still gets a safe fallback card. Validate only the routing
      // envelope here; the raw payload remains untrusted and is redacted/bounded before display.
      if (name === 'ui.request') {
        const unknown = normalizeUnknownCustomUiRequest(frame.p)
        if (unknown) this.emitEvent(name, unknown as unknown as EventPayload<RemoteEvent>)
      }
      return
    }
    if (name === 'turn.patch') {
      const p = parsed.data as EventPayload<'turn.patch'>
      const w = this.watched.get(p.sessionKey)
      if (w) {
        const maxSeq = p.patches.reduce((m, x) => {
          const to = x.op === 'text.append' && x.seqTo !== undefined ? x.seqTo : x.seq
          return Math.max(m, to)
        }, w.cursor?.seq ?? 0)
        this.watched.set(p.sessionKey, { ...w, cursor: { epoch: w.cursor?.epoch ?? this.hello?.epoch ?? '', seq: maxSeq } })
      }
    }
    this.emitEvent(name, parsed.data as EventPayload<RemoteEvent>)
  }

  private emitEvent(name: RemoteEvent, payload: EventPayload<RemoteEvent>): void {
    this.events.onEvent?.(name, payload)
    for (const listener of this.eventSubscribers) listener(name, payload)
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (!this.online) return
      try {
        // Protocol-level ping frame (k:'ping'); the host answers pong and the 75s idle timer resets.
        this.sendEncrypted(makePing(`p${++this.reqId}`))
      } catch {
        /* socket dying; close handler will fire */
      }
    }, this.opts.pingIntervalMs)
  }

  private async afterOnline(): Promise<void> {
    try {
      this.hello = await this.request('host.hello', {
        app: { name: 'Li Web', version: '1.0.0', platform: 'browser' },
        caps: { templates: [], piUi: [], uiKinds: [] },
      })
      if (this.hello.hostId !== this.hostId) {
        this.onSocketClose(`hello host identity mismatch (expected ${this.hostId}, received ${this.hello.hostId})`)
        return
      }
      this.events.onHello?.(this.hello)
      if (!this.opts.resumeSessions) return
      for (const [key, w] of this.watched) {
        try {
          await this.openSession(key, w.cursor)
        } catch (e) {
          // Session may have been deleted on the host; drop it from the watch set but stay online.
          if (e instanceof RpcRejectedError && e.rpcError.code === 'not_found') this.watched.delete(key)
        }
      }
    } catch (e) {
      this.onSocketClose(`hello failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private onSocketClose(detail: string): void {
    if (this.stopped) return
    console.warn('[li-web] socket close:', detail)
    // Close handlers can fire twice (hs_err text then socket close, or error + close). Only the
    // first one reconnects; subsequent calls are no-ops.
    if (!this.ws) return
    this.lastError = detail
    this.finisher = null
    const wasOnline = this.online
    this.channel = null
    this.clearTimers()
    this.failPending(new DisconnectedError(detail))
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
    this.ws = null
    if (this.stopped) return
    this.setState('reconnecting', detail)
    const delay = this.backoff.nextDelay()
    if (delay === null) {
      this.setState('error', `reconnect budget exhausted: ${detail}`)
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.start()
    }, delay)
  }

  private sendEncrypted(frame: Frame): void {
    if (!this.channel || !this.ws) throw new DisconnectedError()
    this.ws.send(this.channel.encrypt(frame))
  }
}

export type { BackoffOptions }
