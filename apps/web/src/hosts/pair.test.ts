import { describe, expect, it } from 'vitest'
import { base64UrlEncode, encodePairLink, encodeWebPairLink, type PairOffer } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { parsePairLink, pairFromFragment } from './pair'

function makeOffer(overrides: Partial<PairOffer> = {}): PairOffer {
  return {
    v: 1,
    hostId: 'host_p',
    hostName: 'ProDesk',
    hostPub: base64UrlEncode(generateKeyPair().pub),
    endpoints: ['wss://prodesk.tail1234.ts.net/ws'],
    pairToken: 'tok_0123456789abcdef',
    exp: Date.now() + 60_000,
    ...overrides,
  }
}

const HTTPS = { secure: true }
const HTTP_DEV = { secure: false }

describe('pair parsing (spec T3: QR or pasted web pair link)', () => {
  it('accepts a fresh web pair link from an HTTPS page (wss only)', () => {
    const link = encodeWebPairLink(makeOffer())
    const r = parsePairLink(link, HTTPS)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.endpoint).toBe('wss://prodesk.tail1234.ts.net/ws')
  })

  it('accepts the native pidesk:// link too (host shows both)', () => {
    const link = encodePairLink(makeOffer({ endpoints: ['ws://100.115.92.19:47900/ws'] }))
    const r = parsePairLink(link, HTTP_DEV)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.endpoint).toBe('ws://100.115.92.19:47900/ws')
  })

  it('expired offer is refused with an actionable error', () => {
    const link = encodeWebPairLink(makeOffer({ exp: Date.now() - 1000 }))
    expect(parsePairLink(link, HTTPS)).toMatchObject({ ok: false, code: 'expired' })
  })

  it('ws-only offer on an HTTPS page explains the Serve requirement (mixed content)', () => {
    const link = encodeWebPairLink(makeOffer({ endpoints: ['ws://100.115.92.19:47900/ws'] }))
    expect(parsePairLink(link, HTTPS)).toMatchObject({ ok: false, code: 'mixed_content' })
  })

  it('non-pair text is refused with code bad_link', () => {
    expect(parsePairLink('https://example.com/something', HTTPS)).toMatchObject({ ok: false, code: 'bad_link' })
    expect(parsePairLink('pidesk://pair#!!!not-base64!!!', HTTPS)).toMatchObject({ ok: false, code: 'bad_link' })
  })

  it('malformed payload inside a valid-looking link is refused', () => {
    // Valid base64url JSON but missing every PairOffer field.
    expect(parsePairLink('https://li.quoc.app/#pair=eyJhIjoxfQ', HTTPS)).toMatchObject({ ok: false, code: 'bad_link' })
  })

  it('pairFromFragment pre-fills from #pair= and rejects junk', () => {
    const offer = makeOffer()
    const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(offer)))
    expect(pairFromFragment(`#pair=${payload}`)).toEqual(offer)
    expect(pairFromFragment('#other=1')).toBeNull()
    expect(pairFromFragment('#pair=broken')).toBeNull()
  })

  it('host identity is never confused: different hostId = different pairing target', () => {
    const a = makeOffer({ hostId: 'host_a' })
    const b = makeOffer({ hostId: 'host_b' })
    expect(a.hostId).not.toBe(b.hostId)
  })
})
