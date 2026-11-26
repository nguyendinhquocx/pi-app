import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { normalizeSessionFileKey } from '@shared/session-file-key'
import { base64UrlEncode, encodePairLink, encodeWebPairLink, isPrivateHost, type Role } from '@shared/remote'
import { AssetStore } from './assets'
import { AuthStore, sameSecret, type DeviceRecord } from './auth-store'
import { RemoteConnection } from './connection'
import type { RemoteHostPort, RemoteTapSink } from './host-port'
import { RemoteRpc } from './rpc'
import { SessionHub } from './session-hub'
import { setRemoteTapSink } from './tap'
import { UiRouter } from './ui-router'

export const REMOTE_FEATURES = ['capabilities', 'cacheWarming', 'sessionCreate', 'assets', 'ownerProtocol', 'terminal', 'files', 'sessionOps']
const HANDSHAKE_FAILS_PER_MIN = 20

const isLoopback = (ip: string): boolean => /^(::ffff:)?127\./.test(ip) || ip === '::1'
const MAX_PAYLOAD = 16 * 1024 * 1024

/**
 * WebSocket upgrade Origin policy (spec T2): browsers always send `Origin`; a native client does
 * not. A browser Origin must match the allowlist exactly (the static PWA + local dev); anything
 * else gets a 403 BEFORE the Noise-IK handshake ever runs. No-Origin requests proceed to the
 * handshake, which stays the real gate (host key + device key or one-shot pair token).
 */
const ALLOWED_ORIGINS = ['https://li.quoc.app']
const ALLOWED_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i

export function originAllowed(origin: string | undefined, serveHostname?: string): boolean {
  if (origin === undefined) return true // native clients (Android ws, curl) send no Origin header
  if (ALLOWED_ORIGINS.includes(origin)) return true
  if (ALLOWED_ORIGIN_RE.test(origin)) return true
  // The owner-approved Tailscale Serve hostname is a first-class PWA origin (spec T5 UAT):
  // the browser connects through Serve TLS (`https://<serve-host>[:<listener-port>]`), so any
  // port on exactly that hostname is same-host — the Serve gate itself is owner-controlled.
  if (serveHostname) {
    const normalized = serveHostname.replace(/^https?:\/\//i, '').replace(/\/.*/, '').toLowerCase()
    const m = /^https:\/\/([^/:]+)(?::\d+)?$/i.exec(origin)
    if (m && m[1].toLowerCase() === normalized) return true
  }
  return false
}

/**
 * Host-header policy: the upgrade must be addressed to a host the gateway actually serves —
 * Tailscale MagicDNS names, Tailscale/CGNAT IPs, LAN/private IPs or loopback. Public hostnames
 * (DNS-rebinding attempts) are refused before the handshake.
 */
export function hostHeaderAllowed(host: string | undefined): boolean {
  if (!host) return false
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname) return false
  return isPrivateHost(hostname)
}

/**
 * Admin-plane peer rule (spec Li TUI pair panel T1): the three loopback forms a loopback peer can
 * present. Exported pure for tests — a real socket cannot present `::ffff:192.168.1.22`, so the
 * mapped-non-loopback denial is asserted on this helper while the handler uses it for real.
 * Deliberately NOT the broader `isLoopback` above (which also matches other `::ffff:127.*` forms).
 */
export function isLoopbackAddress(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/** Admin-plane Host rule: loopback addressing only — NOT `hostHeaderAllowed()`, which accepts
 *  LAN / `*.ts.net` hosts and rejects `localhost`, both wrong for the admin plane. */
export const ADMIN_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i
const ADMIN_BODY_LIMIT = 16 * 1024
const ADMIN_ID_RE = /^[A-Za-z0-9_-]+$/

export type GatewayDevice = Omit<DeviceRecord, 'pub'> & { fingerprint: string; online: boolean }

export type GatewayStatus = {
  enabled: boolean
  listening: boolean
  port: number
  error?: string
  endpoints: string[]
  endpointInfo: EndpointInfo[]
  hostId: string
  hostName: string
  hostKeyEphemeral: boolean
  pairing: { link: string; exp: number } | null
  devices: GatewayDevice[]
  projects: string[]
  trustedProjects: string[]
  /** Labels for temporary-chat sandboxes (the folder name is a random id). */
  projectInfo: Record<string, { label?: string; temporary?: boolean }>
}

export type EndpointKind = 'lan' | 'tailscale' | 'overlay'
export type EndpointInfo = { url: string; kind: EndpointKind }

/** Container bridges, proxy TUNs (Clash/mihomo, sing-box) and VM host-only nets: never reachable from the phone. */
const VIRTUAL_IF = /^(docker|br-|veth|virbr|vmnet|vboxnet|vethernet|tap|meta|clash|mihomo|nekoray|singbox|sing-box|lxc|lxd|podman|cni|flannel|kube)/i
/** Generic tunnels: only overlay addresses on them count (Tailscale's macOS `utun`, OpenVPN `tun`). */
const TUNNEL_IF = /^(tun|utun)/i
/** Mesh VPN adapters the phone can join too: any private address on them is reachable. */
const OVERLAY_IF = /^(tailscale|zt|zerotier|wg|wireguard|feth)/i

const isCgnat = (ip: string) => {
  const [a, b] = ip.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

/**
 * Addresses for the pairing QR, best first: home Wi-Fi / Ethernet, then mesh overlays (Tailscale,
 * ZeroTier, WireGuard) for use away from the LAN. Proxy TUNs and container bridges are skipped: a
 * phone would spend a connect timeout on each before reaching a real address.
 */
export function hostAddresses(interfaces = networkInterfaces()): { host: string; kind: EndpointKind }[] {
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3)
  const lan: string[] = []
  const overlay = new Map<string, EndpointKind>()
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL_IF.test(name)) continue
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateHost(a.address) || a.address.startsWith('169.254.')) continue
      // 198.18.0.0/15 is the benchmark range TUN proxies hand out (Clash fake-ip).
      if (/^198\.1[89]\./.test(a.address)) continue
      const tailscale = isCgnat(a.address) || /^tailscale/i.test(name)
      if (tailscale || OVERLAY_IF.test(name)) overlay.set(a.address, tailscale ? 'tailscale' : 'overlay')
      else if (!TUNNEL_IF.test(name)) lan.push(a.address)
    }
  }
  const lanSorted = [...new Set(lan)].sort((a, b) => rank(a) - rank(b))
  return [...lanSorted.map((host) => ({ host, kind: 'lan' as const })), ...[...overlay].filter(([h]) => !lan.includes(h)).map(([host, kind]) => ({ host, kind }))]
}

/** LAN and overlay addresses for the pairing QR, best first. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  return hostAddresses(interfaces).map((a) => a.host)
}

export class RemoteGateway {
  readonly auth: AuthStore
  readonly ui: UiRouter
  readonly hub: SessionHub
  private readonly assets: AssetStore
  private readonly rpc: RemoteRpc
  private readonly conns = new Set<RemoteConnection>()
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private listenError: string | undefined
  private readonly failures = new Map<string, { count: number; since: number }>()

  constructor(
    private readonly port: RemoteHostPort,
    private readonly now: () => number = Date.now,
  ) {
    this.auth = new AuthStore(port, now)
    this.ui = new UiRouter(port, (event, payload, sessionKey) => {
      for (const c of this.hub.subscribersOf(sessionKey)) c.sendEvent(event, payload)
      this.hub.onUiChanged(sessionKey)
    })
    this.hub = new SessionHub(port, this.ui, () => this.allowedProjects(), now)
    this.assets = new AssetStore(port)
    this.rpc = new RemoteRpc({
      port,
      hub: this.hub,
      ui: this.ui,
      hostId: () => this.auth.config.hostId,
      assets: () => this.assets.infos(),
      features: REMOTE_FEATURES,
      endpoints: () => this.endpoints(),
      ownerProtocol: () => this.port.hostStatus().ownerProtocol ?? null,
      webPairLink: () => this.webPairLink(),
    })
  }

  /** Whitelisted projects the desktop still trusts. */
  allowedProjects(): string[] {
    const trusted = this.port.trustedProjects()
    const keys = new Set(this.auth.config.projects.map((p) => normalizeSessionFileKey(p).replace(/\/+$/, '')))
    return trusted.filter((t) => keys.has(normalizeSessionFileKey(t).replace(/\/+$/, '')))
  }

  get sink(): RemoteTapSink {
    return {
      appEvent: (event) => this.hub.onAppEvent(event),
      uiRequest: (request) => this.ui.onDesktopRequest(request),
      uiResolved: (id, by) => this.ui.onResolved(id, by),
      settingsChanged: (key, sessionFile) => {
        const sessionKey = sessionFile ? normalizeSessionFileKey(sessionFile) : undefined
        for (const c of this.conns) if (c.ready) c.sendEvent('settings.changed', { key, ...(sessionKey ? { sessionKey } : {}) })
      },
    }
  }

  get listening(): boolean {
    return !!this.server?.listening
  }

  /** Port actually bound (differs from the configured one only when tests pass `port: 0`). */
  get boundPort(): number {
    const addr = this.server?.address()
    return addr && typeof addr === 'object' ? addr.port : this.auth.config.port
  }

  async start(opts: { port?: number; host?: string } = {}): Promise<void> {
    if (this.server) return
    this.auth.hostKey()
    // Materialize the admin token file at gateway start (re-created if deleted) so the local pair
    // panel can read it without any admin request ever having been made.
    this.port.adminToken?.()
    await this.assets.warm()
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
    const server = createServer((req, res) => {
      // Keep unexpected HTTP-handler rejections inside the request boundary. Do not echo/log the
      // exception: filesystem errors can contain the userData/admin-token path.
      void this.onHttp(req, res).catch(() => {
        if (res.destroyed || res.writableEnded) return
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('internal server error')
      })
    })
    server.on('upgrade', (req, socket, head) => this.onUpgrade(wss, req, socket, head))
    await new Promise<void>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        reject(e)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(opts.port ?? this.auth.config.port, opts.host ?? '0.0.0.0')
    }).catch((e: NodeJS.ErrnoException) => {
      this.listenError = e.code === 'EADDRINUSE' ? 'port_in_use' : e.code || e.message
      throw e
    })
    this.listenError = undefined
    this.server = server
    this.wss = wss
    setRemoteTapSink(this.sink)
    this.port.log('info', `[remote] gateway listening on :${this.boundPort}`)
  }

  async stop(): Promise<void> {
    setRemoteTapSink(null)
    for (const c of [...this.conns]) c.close(1001, 'gateway stopped')
    this.conns.clear()
    // suspend, NOT dispose: the hub (and its app-level rows-refresh + watcher target) must survive
    // disable/enable and port changes — only final teardown may dispose.
    this.hub.suspend()
    this.auth.clearPairing()
    const server = this.server
    const wss = this.wss
    this.server = null
    this.wss = null
    wss?.close()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /**
   * Loopback peers are exempt: a local tunnel client (frpc, `ssh -R`) relays every remote phone from
   * 127.0.0.1, so one shared bucket would let anyone scanning the public port lock the owner out. The
   * handshake itself stays the gate (host key + device key or a one-shot pair token).
   */
  private rateLimited(ip: string): boolean {
    if (isLoopback(ip)) return false
    const f = this.failures.get(ip)
    if (!f) return false
    if (this.now() - f.since > 60_000) {
      this.failures.delete(ip)
      return false
    }
    return f.count >= HANDSHAKE_FAILS_PER_MIN
  }

  private recordFailure(ip: string): void {
    const f = this.failures.get(ip)
    if (!f || this.now() - f.since > 60_000) this.failures.set(ip, { count: 1, since: this.now() })
    else f.count++
  }

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = req.socket.remoteAddress ?? ''
    const path = (req.url ?? '').split('?')[0]
    // `/ws` is the canonical endpoint; `/` is accepted for the TLS-terminated TCP serve lane
    // (`wss://serve:8443` — TCP forwarding keeps whatever path the client used). A request to
    // any other path is a probe and gets a fast 404 before any handshake work.
    if (path !== '/ws' && path !== '/') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    // Origin + Host checks run BEFORE handleUpgrade: a mismatched browser context never reaches
    // the handshake and never opens a WebSocket frame.
    if (!originAllowed(req.headers.origin, this.serveHostname())) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    if (!hostHeaderAllowed(req.headers.host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    if (this.rateLimited(ip)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new RemoteConnection(ws, {
        auth: this.auth,
        hub: this.hub,
        rpc: this.rpc,
        port: this.port,
        hostName: () => this.port.hostName(),
        onHandshakeFailure: () => this.recordFailure(ip),
        onClosed: (c) => {
          this.conns.delete(c)
          // Kill any PTYs this connection opened so no host terminal outlives its client.
          this.rpc.detachTerminals(c.id)
        },
      })
      this.conns.add(conn)
      // Attribution for the host log (spec T5 UAT): which ingress path/IP each connection used.
      conn.remoteIp = ip
      conn.handshakePath = path
    })
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    if (path.startsWith('/admin/')) return this.onAdmin(req, res, path)
    const m = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(path)
    if (req.method === 'OPTIONS' && m) {
      // Preflight for the browser PWA; allow only the approved origins.
      const origin = req.headers.origin
      if (typeof origin === 'string' && originAllowed(origin, this.serveHostname())) {
        res.writeHead(204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
          vary: 'Origin',
        })
        res.end()
        return
      }
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('origin not allowed')
      return
    }
    if (req.method === 'GET' && m) {
      const asset = await this.assets.load(m[1])
      if (asset) {
        const origin = req.headers.origin
        const allowOrigin = typeof origin === 'string' && originAllowed(origin, this.serveHostname()) ? origin : undefined
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'content-length': String(asset.body.length),
          'cache-control': 'public, max-age=86400',
          'x-content-sha256': asset.info.sha256,
          ...(allowOrigin ? { 'access-control-allow-origin': allowOrigin, vary: 'Origin' } : {}),
        })
        res.end(asset.body)
        return
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }

  // ── Admin API v1 (spec Li TUI pair panel T1) ──

  /**
   * Local control plane for the Li TUI pair panel: status / regenerate / revoke. Every request
   * passes the same four gates in order — loopback peer, loopback Host header, Bearer admin
   * token, bounded JSON body — and a failing gate answers 403 without reflecting which one.
   * Deliberately shares nothing with the WS-lane policies: the Host rule and the peer rule here
   * are loopback-only (see ADMIN_HOST_RE / isLoopbackAddress), no CORS headers are ever set, and
   * nothing on this path is logged (tokens and responses carry pair secrets that must never
   * reach the host log).
   */
  private async onAdmin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const deny = () => {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end()
    }
    const methodNotAllowed = () => {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'method_not_allowed' }))
    }
    // Gate 1 — loopback peer.
    if (!isLoopbackAddress(req.socket.remoteAddress ?? '')) return deny()
    // Gate 2 — loopback Host header (DNS-rebinding defense-in-depth). A request must carry exactly
    // one Host header: Node merges duplicates into the first value, so `Host: localhost` followed by
    // `Host: evil.com` would pass the regex on `req.headers` — count the raw headers instead
    // (rawHeaders is a flat [name, value, …] array, hence the 2-step scan).
    let hostCount = 0
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'host') hostCount++
    if (hostCount !== 1 || !ADMIN_HOST_RE.test(req.headers.host ?? '')) return deny()
    // Gate 3 — Bearer token via constant-time compare; a length-mismatched token must 403, not crash.
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const expected = this.port.adminToken?.()
    if (!expected || !bearer || !sameSecret(bearer, expected)) return deny()
    // Gate 4 — bounded body for every POST, before any route-specific parsing.
    let body: string | null = null
    if (req.method === 'POST') {
      body = await this.readBoundedBody(req, ADMIN_BODY_LIMIT)
      if (body === null) {
        // Discard the oversized upload and answer 413: destroying the socket would RST away the
        // response itself. The connection closes normally once the discarded stream drains.
        req.resume()
        res.writeHead(413, { 'content-type': 'text/plain' })
        res.end()
        return
      }
    }
    if (path === '/admin/v1/status') {
      if (req.method !== 'GET') return methodNotAllowed()
      return this.respondJson(res, this.adminPayload())
    }
    if (path === '/admin/v1/regenerate') {
      if (req.method !== 'POST') return methodNotAllowed()
      // Contract says no body: a non-empty body is a client bug — reject it instead of ignoring it.
      if (body !== null && body.trim() !== '') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unexpected_body' }))
        return
      }
      this.auth.newPairToken() // spends the previous token immediately
      return this.respondJson(res, this.adminPayload())
    }
    if (path === '/admin/v1/revoke') {
      if (req.method !== 'POST') return methodNotAllowed()
      let parsed: unknown
      try {
        parsed = JSON.parse(body ?? '')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_json' }))
        return
      }
      const id = parsed && typeof parsed === 'object' ? (parsed as { id?: unknown }).id : undefined
      if (typeof id !== 'string' || !ADMIN_ID_RE.test(id)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_id' }))
        return
      }
      const ok = this.revokeDevice(id) // closes live connections with 4006 `revoked`
      return this.respondJson(res, { ...this.adminPayload(), ok })
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  }

  private respondJson(res: ServerResponse, payload: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  /** Resolve with the body up to `limit` bytes, or null once it exceeds the limit. */
  private readBoundedBody(req: IncomingMessage, limit: number): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      req.on('data', (c: Buffer) => {
        if (settled) return
        size += c.length
        if (size > limit) {
          settled = true
          resolve(null)
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', () => {
        if (settled) return
        settled = true
        resolve(null)
      })
    })
  }

  /** Status + web pairing + serve hostname payload shared by the admin routes. */
  private adminPayload(): { v: 1; status: GatewayStatus; webPairing: { link: string; exp: number } | null; serveHostname: string | null } {
    const pairing = this.auth.currentPairing
    const link = pairing ? this.webPairLink() : null
    const status = this.status(this.auth.config.enabled)
    // Admin responses expose exactly one credential lane: the web pair link above. GatewayStatus
    // also carries `pairing` — the mobile link with the same one-shot token in a second format —
    // so it is stripped here: no admin response ever contains a mobile link (spec Task 1).
    return {
      v: 1,
      status: { ...status, pairing: null },
      webPairing: pairing && link ? { link, exp: pairing.exp } : null,
      serveHostname: this.adminServeHostname(),
    }
  }

  /** The Tailscale Serve hostname the phone actually connects to, parsed from the active `wss://<host>/ws` endpoint. */
  private adminServeHostname(): string | null {
    const tailscale = this.endpointInfo().filter((e) => e.kind === 'tailscale')
    const entry = tailscale.find((e) => e.url.endsWith('/ws')) ?? tailscale[0]
    const m = /^wss:\/\/([^/]+?)(?::\d+)?(?:\/|$)/.exec(entry?.url ?? '')
    return m ? m[1] : null
  }

  // ── Settings page operations ──

  pairLink(): { link: string; exp: number } | null {
    const p = this.auth.currentPairing
    const endpoints = this.endpoints()
    if (!p || !endpoints.length) return null
    return {
      link: encodePairLink({
        v: 1,
        hostId: this.auth.config.hostId,
        hostName: this.port.hostName(),
        hostPub: base64UrlEncode(this.auth.hostKey().pub),
        endpoints,
        pairToken: p.token,
        exp: p.exp,
      }),
      exp: p.exp,
    }
  }

  /** Overridable for tests and the dev host (loopback). */
  endpointHosts: () => { host: string; kind: EndpointKind }[] = () => hostAddresses()
  /** This machine's Tailscale MagicDNS name (`pc.tail1234.ts.net`), found once the gateway starts. */
  tailnetName: string | null = null

  /** The Electron adapter reports only the active, exact Tailscale Serve route; tests/older adapters may use persisted config. */
  private serveHostname(): string | undefined {
    if (typeof this.port.serveConfig === 'function') return this.port.serveConfig() ?? undefined
    return this.auth.config.serve?.hostname
  }

  endpointInfo(): EndpointInfo[] {
    const hosts = this.endpointHosts()
    const all = this.tailnetName ? [...hosts, { host: this.tailnetName, kind: 'tailscale' as const }] : hosts
    const out = all.map(({ host, kind }) => ({ url: `ws://${host.includes(':') ? `[${host}]` : host}:${this.boundPort}`, kind }))
    // The Electron adapter reports only its exact active HTTPS /ws route. The persisted host/tcp
    // hint remains a compatibility fallback for older adapters that lack a live Serve reader.
    const serve = this.serveHostname()
    const legacyTcpPort = typeof this.port.serveConfig === 'function' ? undefined : this.auth.config.serve?.tcpPort
    if (serve && legacyTcpPort) out.push({ url: `wss://${serve}:${legacyTcpPort}`, kind: 'tailscale' })
    if (serve) out.push({ url: `wss://${serve}/ws`, kind: 'tailscale' })
    return out
  }

  endpoints(): string[] {
    return this.endpointInfo().map((e) => e.url)
  }

  /** Browser pairing link (https://li.quoc.app/#pair=…) for the current pairing, if any. */
  webPairLink(): string | null {
    const p = this.auth.currentPairing
    const endpoints = this.endpoints()
    if (!p || !endpoints.length) return null
    return encodeWebPairLink({
      v: 1,
      hostId: this.auth.config.hostId,
      hostName: this.port.hostName(),
      hostPub: base64UrlEncode(this.auth.hostKey().pub),
      endpoints,
      pairToken: p.token,
      exp: p.exp,
    })
  }

  regeneratePairing(): { link: string; exp: number } | null {
    this.auth.newPairToken()
    return this.pairLink()
  }

  revokeDevice(id: string): boolean {
    const ok = this.auth.revokeDevice(id)
    for (const c of [...this.conns]) if (c.deviceId === id) c.close(4006, 'revoked')
    return ok
  }

  removeDevice(id: string): boolean {
    const ok = this.auth.removeDevice(id)
    for (const c of [...this.conns]) if (c.deviceId === id) c.close(4006, 'removed')
    return ok
  }

  setDeviceRole(id: string, role: Role): boolean {
    return this.auth.setDeviceRole(id, role)
  }

  status(enabled: boolean): GatewayStatus {
    const online = new Set([...this.conns].filter((c) => c.ready).map((c) => c.deviceId))
    return {
      enabled,
      listening: this.listening,
      port: this.auth.config.port,
      ...(this.listenError ? { error: this.listenError } : {}),
      endpoints: this.endpoints(),
      endpointInfo: this.endpointInfo(),
      hostId: this.auth.config.hostId,
      hostName: this.port.hostName(),
      hostKeyEphemeral: this.listening ? this.auth.hostKeyIsEphemeral : false,
      pairing: this.listening ? this.pairLink() : null,
      devices: this.auth.config.devices.map(({ pub, ...d }) => ({ ...d, fingerprint: pub.slice(0, 8), online: online.has(d.id) })),
      projects: this.auth.config.projects,
      trustedProjects: this.port.trustedProjects(),
      projectInfo: Object.fromEntries(
        this.port.trustedProjects().flatMap((p) => {
          const info = this.port.projectInfo?.(p)
          return info && (info.label || info.temporary) ? [[p, info]] : []
        }),
      ),
    }
  }
}
