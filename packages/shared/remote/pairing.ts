import { z } from 'zod'

/** Pairing QR payload: `pidesk://pair#<base64url(JSON)>`. Valid for one use, five minutes. */

export const PAIR_LINK_PREFIX = 'pidesk://pair#'
/** Browser pairing entry (static PWA): same payload after the fragment marker. */
export const WEB_PAIR_LINK_BASE = 'https://li.quoc.app/#pair='
export const PAIR_TOKEN_TTL_MS = 5 * 60_000

export const PairOfferSchema = z
  .object({
    v: z.literal(1),
    hostId: z.string().min(1),
    hostName: z.string(),
    hostPub: z.string().min(1),
    endpoints: z.array(z.string().min(1)).min(1),
    pairToken: z.string().min(16),
    exp: z.number().int(),
  })
  .strict()
export type PairOffer = z.infer<typeof PairOfferSchema>

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function encodePairLink(offer: PairOffer): string {
  return PAIR_LINK_PREFIX + base64UrlEncode(new TextEncoder().encode(JSON.stringify(PairOfferSchema.parse(offer))))
}

/** Same offer as a browser pair link (`https://li.quoc.app/#pair=…`) for the Li Web client. */
export function encodeWebPairLink(offer: PairOffer): string {
  return WEB_PAIR_LINK_BASE + base64UrlEncode(new TextEncoder().encode(JSON.stringify(PairOfferSchema.parse(offer))))
}

/** Returns null when the text is not a pair link; throws when it is one but malformed. */
export function decodePairLink(text: string): PairOffer | null {
  const trimmed = text.trim()
  let payload: string | null = null
  if (trimmed.startsWith(PAIR_LINK_PREFIX)) payload = trimmed.slice(PAIR_LINK_PREFIX.length)
  else if (trimmed.startsWith(WEB_PAIR_LINK_BASE)) payload = trimmed.slice(WEB_PAIR_LINK_BASE.length)
  if (payload === null) return null
  const json = new TextDecoder('utf-8', { fatal: true }).decode(base64UrlDecode(payload))
  return PairOfferSchema.parse(JSON.parse(json))
}

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((p) => p <= 255) ? parts : null
}

/** Tailscale MagicDNS names (`pc.tail1234.ts.net`): resolve to the tailnet's CGNAT addresses. */
const TAILNET_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net\.?$/

/**
 * Private-network guard for pairing endpoints: RFC 1918, CGNAT (Tailscale-style overlays), loopback,
 * link-local, IPv6 ULA / link-local and Tailscale MagicDNS names. Other hostnames are rejected.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (TAILNET_NAME.test(h)) return true
  const v4 = ipv4Parts(h)
  if (v4) {
    const [a, b] = v4
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    )
  }
  if (!h.includes(':')) return false
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
}

/**
 * Pairing/connect endpoints. `ws://` keeps the explicit-port rule (LAN/Tailscale endpoints);
 * `wss://` defaults to 443 (TLS terminates at Tailscale Serve), an explicit port is also accepted.
 * Both require a private host (RFC1918 / CGNAT / loopback / ULA / `*.ts.net`).
 */
export function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    if (url.protocol === 'ws:') return !!url.port && isPrivateHost(url.hostname)
    if (url.protocol === 'wss:') return isPrivateHost(url.hostname)
    return false
  } catch {
    return false
  }
}
