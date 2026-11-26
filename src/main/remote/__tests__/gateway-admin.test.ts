import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request, type IncomingMessage } from 'node:http'
import { base64UrlDecode, decodePairLink } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { ADMIN_HOST_RE, RemoteGateway, isLoopbackAddress } from '../gateway'
import { FakeHost } from '../testing/fake-host'
import { NodeRemoteClient } from '../testing/node-client'

/**
 * Admin API v1 gates (spec Li TUI pair panel T1). The pair-token gates live in `gateway.test.ts`;
 * this suite covers the `/admin/v1/*` control plane only: 4-layer gate order, bounded bodies,
 * id validation, web-pair-only payloads and the no-token-in-logs guarantee.
 */

let host: FakeHost
let gw: RemoteGateway
let token: string
const clients: NodeRemoteClient[] = []

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

/** Poll a condition with a deadline — avoids fixed sleeps on slow CI machines. */
const until = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await settle(20)
  }
}

beforeEach(async () => {
  host = new FakeHost({ projects: ['/work/pi-app'] })
  host.store.set('remote', { enabled: true, port: 47900, hostId: 'h_admin', devices: [], projects: ['/work/pi-app'] })
  gw = new RemoteGateway(host)
  gw.endpointHosts = () => [{ host: '127.0.0.1', kind: 'lan' }]
  await gw.start({ port: 0, host: '127.0.0.1' })
  token = host.adminToken()
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await gw.stop()
  host.dispose()
})

type AdminOpts = { method?: string; path?: string; hostHeader?: string; bearer?: string; body?: string; localAddress?: string }
type AdminRes = { status: number; text: string; headers: IncomingMessage['headers'] }

/** Raw admin request against the gateway under test; the Host header is set explicitly. */
function admin(opts: AdminOpts = {}): Promise<AdminRes> {
  const port = gw.boundPort
  return new Promise((resolve, reject) => {
    let res: IncomingMessage | null = null
    const chunks: Buffer[] = []
    let settled = false
    const finish = () => {
      if (settled || !res) return
      settled = true
      resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
    }
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/admin/v1/status',
        localAddress: opts.localAddress ?? '127.0.0.1',
        headers: {
          host: opts.hostHeader ?? `127.0.0.1:${port}`,
          ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
          ...(opts.body !== undefined ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}),
        },
      },
      (r) => {
        res = r
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', finish)
        r.on('close', finish)
      },
    )
    // A 413 answers while the oversized upload is still in flight; the late reset must not fail the test.
    req.on('error', () => {
      if (!res) reject(new Error('admin request failed before a response'))
      else finish()
    })
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

const adminOk = (path: string, extra: AdminOpts = {}) => admin({ path, bearer: token, ...extra })

async function pairNew(name = 'admin-phone'): Promise<NodeRemoteClient> {
  const o = decodePairLink(gw.regeneratePairing()!.link)!
  const c = new NodeRemoteClient(generateKeyPair(), name)
  await c.connect(o.endpoints[0], base64UrlDecode(o.hostPub), o.pairToken)
  clients.push(c)
  return c
}

async function reconnect(c: NodeRemoteClient): Promise<NodeRemoteClient> {
  const o = decodePairLink(gw.regeneratePairing()!.link)!
  const next = new NodeRemoteClient(c.identity, c.name)
  await next.connect(o.endpoints[0], base64UrlDecode(o.hostPub))
  clients.push(next)
  return next
}

describe('admin api v1', () => {
  it('admin_allows_ipv4_mapped_loopback_and_denies_mapped_non_loopback', async () => {
    // Pure helper first: a real socket cannot present a mapped non-loopback address, so the denial
    // is asserted on the exact helper the handler runs.
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:192.168.1.22')).toBe(false)
    expect(isLoopbackAddress('::ffff:10.0.0.5')).toBe(false)
    expect(isLoopbackAddress('192.168.1.22')).toBe(false)
    expect(isLoopbackAddress('::ffff:8.8.8.8')).toBe(false)
    // Integration: a dual-stack listener reports an IPv4 loopback peer as ::ffff:127.0.0.1, and it passes.
    await gw.stop()
    await gw.start({ port: 0, host: '::' })
    const r = await adminOk('/admin/v1/status', { localAddress: '127.0.0.1' })
    expect(r.status, r.text).toBe(200)
  })

  it('admin_allows_localhost_and_127_host_headers_denies_lan_hostname', async () => {
    const port = gw.boundPort
    for (const h of [`localhost:${port}`, `127.0.0.1:${port}`, 'localhost']) {
      expect((await adminOk('/admin/v1/status', { hostHeader: h })).status, `host=${h}`).toBe(200)
    }
    for (const h of ['evil.com', `evil.com:${port}`, '192.168.1.22:47900', 'myhost.tail1234.ts.net']) {
      expect((await adminOk('/admin/v1/status', { hostHeader: h })).status, `host=${h}`).toBe(403)
    }
    expect(ADMIN_HOST_RE.test('LOCALHOST:47900')).toBe(true) // case-insensitive per contract
  })

  it('admin rejects a missing, wrong or length-mismatched bearer token with 403 and no crash', async () => {
    expect((await adminOk('/admin/v1/status', { bearer: 'short' })).status).toBe(403)
    expect((await adminOk('/admin/v1/status', { bearer: `${token}x` })).status).toBe(403)
    expect((await adminOk('/admin/v1/status', { bearer: 'z'.repeat(token.length) })).status).toBe(403) // same length, different secret
    expect((await adminOk('/admin/v1/status', { bearer: 'a'.repeat(500) })).status).toBe(403)
    expect((await adminOk('/admin/v1/status', { bearer: '' })).status).toBe(403)
    expect((await admin({ path: '/admin/v1/status' })).status).toBe(403) // no Authorization header
    expect((await adminOk('/admin/v1/status')).status).toBe(200) // happy path still fine
  })

  it('admin returns 413 for bodies over 16KB and 400 for invalid JSON', async () => {
    const big = 'x'.repeat(16 * 1024 + 1)
    expect((await adminOk('/admin/v1/revoke', { method: 'POST', body: big })).status).toBe(413)
    expect((await adminOk('/admin/v1/regenerate', { method: 'POST', body: big })).status).toBe(413)
    expect((await adminOk('/admin/v1/revoke', { method: 'POST', body: '{not json' })).status).toBe(400)
    expect((await adminOk('/admin/v1/revoke', { method: 'POST', body: '[]' })).status).toBe(400)
    expect((await adminOk('/admin/v1/revoke', { method: 'POST', body: '{"id":"ok_id"}' })).status).toBe(200)
  })

  it('admin_rejects_ids_outside_a_z_a_z_0_9_dash_underscore_with_400', async () => {
    for (const id of ['bad id', 'd/../x', 'd;id', '{}', 123, null]) {
      const r = await adminOk('/admin/v1/revoke', { method: 'POST', body: JSON.stringify({ id }) })
      expect(r.status, `id=${String(id)}`).toBe(400)
    }
    expect((await adminOk('/admin/v1/revoke', { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await adminOk('/admin/v1/revoke', { method: 'POST', body: 'null' })).status).toBe(400)
    const unknown = await adminOk('/admin/v1/revoke', { method: 'POST', body: JSON.stringify({ id: 'd_unknown' }) })
    expect(unknown.status).toBe(200)
    expect(JSON.parse(unknown.text).ok).toBe(false) // well-formed id, nothing to revoke
  })

  it('admin_regenerate_returns_web_pair_link_and_spends_the_old_token', async () => {
    // Contract says the regenerate route takes no body — a non-empty one is a client bug.
    expect((await adminOk('/admin/v1/regenerate', { method: 'POST', body: '{"junk":1}' })).status).toBe(400)
    const first = await adminOk('/admin/v1/regenerate', { method: 'POST' })
    expect(first.status).toBe(200)
    const p1 = JSON.parse(first.text)
    expect(p1.v).toBe(1)
    expect(p1.webPairing.link.startsWith('https://li.quoc.app/#pair=')).toBe(true)
    expect(p1.webPairing.exp).toBeGreaterThan(Date.now())
    // The webPairing field itself is web-format (a mobile `pidesk://` link there would break the panel).
    expect(p1.webPairing.link.startsWith('pidesk://')).toBe(false)
    const second = await adminOk('/admin/v1/regenerate', { method: 'POST' })
    expect(second.status).toBe(200)
    const p2 = JSON.parse(second.text)
    expect(p2.webPairing.link).not.toBe(p1.webPairing.link)
    // The old web pair token is spent: a WS pairing attempt with it is refused as pair_used.
    const old = decodePairLink(p1.webPairing.link)!
    await expect(
      new NodeRemoteClient(generateKeyPair()).connect(old.endpoints[0], base64UrlDecode(old.hostPub), old.pairToken),
    ).rejects.toMatchObject({ code: 'pair_used' })
    // …while the freshly minted token still pairs.
    const fresh = decodePairLink(p2.webPairing.link)!
    const c = new NodeRemoteClient(generateKeyPair(), 'regen-phone')
    await c.connect(fresh.endpoints[0], base64UrlDecode(fresh.hostPub), fresh.pairToken)
    clients.push(c)
    expect(c.hello!.deviceId).toMatch(/^d_/)
  })

  it('admin status returns v1, full GatewayStatus, webPairing {link, exp} and a null serveHostname without a serve endpoint', async () => {
    const r = await adminOk('/admin/v1/status')
    expect(r.status).toBe(200)
    expect(r.headers['access-control-allow-origin']).toBeUndefined() // no CORS headers on /admin/*
    const j = JSON.parse(r.text)
    expect(j.v).toBe(1)
    expect(j.status).toMatchObject({ enabled: true, listening: true, hostId: 'h_admin' })
    expect(Array.isArray(j.status.devices)).toBe(true)
    expect(Array.isArray(j.status.endpoints)).toBe(true)
    expect(j.webPairing).toBeNull()
    expect(j.serveHostname).toBeNull() // the fake host only reports a LAN endpoint
    gw.regeneratePairing()
    const r2 = await adminOk('/admin/v1/status')
    const j2 = JSON.parse(r2.text)
    expect(j2.webPairing.link.startsWith('https://li.quoc.app/#pair=')).toBe(true)
    expect(j2.webPairing.exp).toBe(gw.auth.currentPairing!.exp)
    expect(j2.serveHostname).toBeNull()
    // With a live Serve route the hostname is parsed from the active wss://<host>/ws endpoint.
    host.serveConfig = () => 'ts-li-host.tail1234.ts.net'
    const j3 = JSON.parse((await adminOk('/admin/v1/status')).text)
    expect(j3.serveHostname).toBe('ts-li-host.tail1234.ts.net')
  })

  it('admin gates run before route matching: unknown paths 404 after the gate, wrong methods 405', async () => {
    expect((await adminOk('/admin/v1/nope')).status).toBe(404)
    expect((await adminOk('/admin/v2/status')).status).toBe(404)
    expect((await admin({ path: '/admin/v1/nope' })).status).toBe(403) // missing token answers 403 before the 404
    expect((await adminOk('/admin/v1/status', { method: 'POST', body: '{}' })).status).toBe(405)
    expect((await adminOk('/admin/v1/regenerate', { method: 'GET' })).status).toBe(405)
    expect((await adminOk('/admin/v1/status', { method: 'DELETE' })).status).toBe(405)
    const forbidden = await admin({ path: '/admin/v1/status' })
    expect(forbidden.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('admin_pair_flow_never_logs_a_pair_token', async () => {
    await adminOk('/admin/v1/regenerate', { method: 'POST' })
    await adminOk('/admin/v1/status')
    await adminOk('/admin/v1/revoke', { method: 'POST', body: JSON.stringify({ id: 'd_unknown' }) })
    await admin({ path: '/admin/v1/status' }) // 403 gate denial
    await adminOk('/admin/v1/revoke', { method: 'POST', body: 'x'.repeat(17 * 1024) }) // 413
    await adminOk('/admin/v1/revoke', { method: 'POST', body: '{bad' }) // 400
    const logged = host.logs.map((l) => `${l.level}: ${l.message}`).join('\n')
    expect(logged).not.toContain('pt_')
  })

  it('admin_rejects_duplicate_host_headers_even_when_the_first_is_loopback', async () => {
    // Node merges duplicate Host headers into the first value for `req.headers`, so the regex gate
    // alone would see `localhost` and pass — the gate must count raw headers and deny instead.
    const port = gw.boundPort
    const raw = await new Promise<{ status: number }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/admin/v1/status',
          localAddress: '127.0.0.1',
        },
        (r) => {
          r.resume()
          r.on('end', () => resolve({ status: r.statusCode ?? 0 }))
        },
      )
      // Array value = one wire line per item — the only way to put two Host headers on the wire.
      req.setHeader('Host', ['localhost', 'evil.com'])
      req.setHeader('Authorization', `Bearer ${token}`)
      req.on('error', reject)
      req.end()
    })
    expect(raw.status).toBe(403)
  })

  it('admin_responses_never_contain_a_mobile_pair_link', async () => {
    // Regenerate makes the underlying GatewayStatus carry a live mobile `pidesk://` link (same
    // one-shot token, second format). The admin plane strips it: exactly one credential lane.
    const regen = await adminOk('/admin/v1/regenerate', { method: 'POST' })
    expect(regen.text).not.toContain('pidesk://')
    const j = JSON.parse(regen.text)
    expect(j.status.pairing).toBeNull() // stripped, not merely absent
    expect(j.webPairing.link.startsWith('https://li.quoc.app/#pair=')).toBe(true)
    expect((await adminOk('/admin/v1/status')).text).not.toContain('pidesk://')
    const revoke = await adminOk('/admin/v1/revoke', { method: 'POST', body: JSON.stringify({ id: 'd_unknown' }) })
    expect(revoke.text).not.toContain('pidesk://')
    expect(JSON.parse(revoke.text).status.pairing).toBeNull()
  })

  it('admin_revoke_closes_the_live_connection_and_refuses_reconnect', async () => {
    const c = await pairNew()
    const id = c.hello!.deviceId
    const r1 = await adminOk('/admin/v1/revoke', { method: 'POST', body: JSON.stringify({ id }) })
    expect(r1.status).toBe(200)
    const j1 = JSON.parse(r1.text)
    expect(j1.v).toBe(1)
    expect(j1.ok).toBe(true)
    await until(() => c.closeCode === 4006)
    expect(c.closeCode).toBe(4006)
    const r2 = await adminOk('/admin/v1/revoke', { method: 'POST', body: JSON.stringify({ id }) })
    expect(r2.status).toBe(200)
    expect(JSON.parse(r2.text).ok).toBe(false) // idempotent: already revoked
    await expect(reconnect(c)).rejects.toMatchObject({ code: 'revoked' })
  })
})
