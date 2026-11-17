import { isAllowedEndpoint } from '@shared/remote'

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

/** Rank endpoints: wss first (Serve TLS), then ws (explicit port). */
function rank(a: string, b: string): number {
  const aw = a.startsWith('wss:') ? 0 : 1
  const bw = b.startsWith('wss:') ? 0 : 1
  return aw - bw
}

export function chooseEndpoint(endpoints: readonly string[], policy: EndpointPolicy): EndpointChoice {
  const valid = [...endpoints].filter(isAllowedEndpoint).sort(rank)
  const wss = valid.find((e) => e.startsWith('wss:'))
  if (policy.secure) {
    if (wss) return { ok: true, endpoint: wss }
    return { ok: false, reason: 'mixed_content' }
  }
  const first = valid[0]
  if (first) return { ok: true, endpoint: first }
  return { ok: false, reason: 'no_valid_endpoint' }
}
