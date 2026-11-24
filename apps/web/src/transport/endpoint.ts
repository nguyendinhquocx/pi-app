import { isAllowedEndpoint } from '@shared/remote'

/** LiX desktop default gateway port (spec constant) — a wss URL pinning it is the raw lane. */
const DEFAULT_GATEWAY_PORT = 47900

/**
 * Endpoint policy for the browser PWA (spec T3).
 *
 * - An HTTPS page must never open `ws://` (mixed content, and the browser blocks it anyway —
 *   we refuse it ourselves so the error is actionable). Only `wss://` is allowed there.
 * - An HTTP page (local dev on localhost) may use both; `wss://` is preferred when offered.
 * - Every endpoint still has to pass the shared private-host guard (`*.ts.net`, CGNAT,
 *   RFC1918, loopback…) before anything else.
 */
export type EndpointPolicy = {
  /** True when the PWA runs in a secure context (production = HTTPS on li.quoc.app). */
  secure: boolean
}

export type EndpointChoice =
  | { ok: true; endpoint: string }
  | { ok: false; reason: 'no_valid_endpoint' | 'mixed_content' | 'offer_expired' }

export function pagePolicy(loc: Pick<Location, 'protocol'> = location): EndpointPolicy {
  return { secure: loc.protocol === 'https:' }
}

export type LocalNetworkPermission = PermissionState | 'unsupported'

/** Read Chrome's local-network-access permission without prompting or changing permission state. */
export async function queryLocalNetworkAccessPermission(api?: Pick<Permissions, 'query'>): Promise<LocalNetworkPermission> {
  const permissions = api ?? (typeof navigator === 'undefined' ? undefined : navigator.permissions)
  if (!permissions?.query) return 'unsupported'
  try {
    const status = await permissions.query({ name: 'local-network-access' } as unknown as PermissionDescriptor)
    return status.state
  } catch {
    // Browsers that do not implement this permission name reject the query; keep generic recovery.
    return 'unsupported'
  }
}

/** Rank endpoints: wss first (Serve TLS), then ws (explicit port). */
function rank(a: string, b: string): number {
  const aw = a.startsWith('wss:') ? 0 : 1
  const bw = b.startsWith('wss:') ? 0 : 1
  return aw - bw
}

/**
 * Serve-lane score (lower wins): 0 = owner-configured TLS-terminated TCP lane on a non-gateway
 * port (e.g. `wss://host:8443` — `tailscale serve --tls-terminated-tcp`); 0.5 = Serve HTTPS path
 * (`wss://host` or `:443`, the `/ws` HTTP proxy); 1 = raw gateway port (`:47900`, no TLS on the
 * tailnet side). Spec T5: the Serve HTTP proxy drops long-lived browser WebSocket streams, so
 * the TLS-TCP lane must outrank the `/ws` path even when the offer lists the path endpoint last.
 */
/**
 * Serve-lane score (lower wins): 0 = Serve HTTPS proxy path (`/ws` — no port or :443); 0.5 = any
 * other explicit port (owner-configured TLS-terminated TCP lane, e.g. `:8443`); 1 = raw gateway
 * port (`:47900`, no TLS on the tailnet side). Spec T5: the `/ws` HTTPS proxy carries both text
 * and binary WebSocket frames correctly end-to-end, while the TLS-TCP lane has proven flaky
 * from Chromium, so the proxy path is preferred when offered.
 */
function serveScore(e: string): number {
  const rest = e.slice('wss://'.length)
  const hasPath = /[/?#]/.test(rest)
  const hostPart = rest.split(/[/?#]/)[0] ?? ''
  const m = /^([^:]+)(?::(\d+))?$/.exec(hostPart)
  const port = m?.[2]
  if (hasPath && (!port || port === '443')) return 0
  if (!port || port === '443') return 0.5
  if (port === String(DEFAULT_GATEWAY_PORT)) return 1
  return 0.5
}

export function chooseEndpoint(endpoints: readonly string[], policy: EndpointPolicy): EndpointChoice {
  const valid = [...endpoints].filter(isAllowedEndpoint).sort(rank)
  const wss = valid.find((e) => e.startsWith('wss:')) ?? null
  const best = wss ? valid.filter((e) => e.startsWith('wss:')).sort((a, b) => serveScore(a) - serveScore(b))[0] : null
  if (policy.secure) {
    if (best) return { ok: true, endpoint: best }
    return { ok: false, reason: 'mixed_content' }
  }
  const first = valid[0]
  if (first) return { ok: true, endpoint: first }
  return { ok: false, reason: 'no_valid_endpoint' }
}
