import { base64UrlDecode, decodePairLink, PairOfferSchema, type PairOffer } from '@shared/remote'
import { chooseEndpoint, pagePolicy } from '../transport/endpoint'

/**
 * Pairing for the web PWA (spec T3): a host shows a QR (pidesk://pair#… or the web pair link
 * https://li.quoc.app/#pair=…), the browser either scans it or the user pastes it. The offer is
 * single-use and valid for five minutes; endpoints are filtered through the transport policy
 * (HTTPS page → wss only) right here so the pair UI never offers a mixed-content endpoint.
 */

export type PairParseResult =
  | { ok: true; offer: PairOffer; endpoint: string }
  | { ok: false; error: string; code: 'bad_link' | 'expired' | 'no_endpoint' | 'mixed_content' }

export function parsePairLink(text: string, policy = pagePolicy()): PairParseResult {
  let offer: PairOffer
  try {
    const decoded = decodePairLink(text)
    if (!decoded) return { ok: false, error: 'Không phải pair link của LiX (pidesk://pair#… hoặc https://li.quoc.app/#pair=…)', code: 'bad_link' }
    offer = decoded
  } catch (e) {
    return { ok: false, error: `Pair link hỏng: ${e instanceof Error ? e.message : String(e)}`, code: 'bad_link' }
  }
  if (offer.exp < Date.now()) {
    return { ok: false, error: 'Pair token đã hết hạn (5 phút) — tạo QR mới trên LiX desktop', code: 'expired' }
  }
  const choice = chooseEndpoint(offer.endpoints, policy)
  if (!choice.ok) {
    const error =
      choice.reason === 'mixed_content'
        ? 'Host chỉ mở ws:// (không có Tailscale Serve wss) — trang HTTPS không kết nối được; bật Tailscale Serve trên host hoặc mở trang qua HTTP dev'
        : 'Không có endpoint hợp lệ trong offer (phải là private/tailnet host)'
    return { ok: false, error, code: choice.reason === 'mixed_content' ? 'mixed_content' : 'no_endpoint' }
  }
  return { ok: true, offer, endpoint: choice.endpoint }
}

/** Read a pair offer from the URL fragment (`https://li.quoc.app/#pair=…`). */
export function pairFromFragment(hash: string): PairOffer | null {
  if (!hash.startsWith('#pair=')) return null
  const payload = hash.slice('#pair='.length)
  try {
    return PairOfferSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlDecode(payload))))
  } catch {
    return null
  }
}

/** True when this browser already holds a device key for the host. */
export function isHostAlreadyPaired(offer: PairOffer, storedHostIds: readonly string[]): boolean {
  return storedHostIds.includes(offer.hostId)
}
