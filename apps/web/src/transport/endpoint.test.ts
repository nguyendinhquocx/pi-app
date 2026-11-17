import { describe, expect, it } from 'vitest'
import { chooseEndpoint, pagePolicy } from './endpoint'

describe('endpoint policy (spec T3)', () => {
  const WSS_SERVE = 'wss://pc.tail1234.ts.net/ws'
  const WS_CGNAT = 'ws://100.64.0.2:47900/ws'
  const WSS_CGNAT = 'wss://100.64.0.2:8443/ws'
  const WS_PUBLIC = 'ws://example.com:47900' // public host → shared guard rejects
  const WSS_PUBLIC = 'wss://li.quoc.app/ws' // public host → shared guard rejects

  it('HTTPS page: wss only; ws endpoints are refused as mixed content', () => {
    const policy = { secure: true }
    expect(chooseEndpoint([WSS_SERVE], policy)).toEqual({ ok: true, endpoint: WSS_SERVE })
    const r = chooseEndpoint([WS_CGNAT], policy)
    expect(r).toEqual({ ok: false, reason: 'mixed_content' })
    // Mixed list: wss preferred, ws never selected on HTTPS.
    expect(chooseEndpoint([WS_CGNAT, WSS_SERVE, WS_CGNAT], policy)).toEqual({ ok: true, endpoint: WSS_SERVE })
  })

  it('HTTP (dev) page: both protocols allowed, wss preferred when offered', () => {
    const policy = { secure: false }
    expect(chooseEndpoint([WS_CGNAT], policy)).toEqual({ ok: true, endpoint: WS_CGNAT })
    expect(chooseEndpoint([WS_CGNAT, WSS_SERVE], policy)).toEqual({ ok: true, endpoint: WSS_SERVE })
  })

  it('public endpoints are always rejected by the shared private-host guard', () => {
    expect(chooseEndpoint([WS_PUBLIC], { secure: false })).toEqual({ ok: false, reason: 'no_valid_endpoint' })
    expect(chooseEndpoint([WSS_PUBLIC], { secure: true })).toEqual({ ok: false, reason: 'mixed_content' })
  })

  it('pagePolicy follows the page protocol', () => {
    expect(pagePolicy({ protocol: 'https:' })).toEqual({ secure: true })
    expect(pagePolicy({ protocol: 'http:' })).toEqual({ secure: false })
  })
})
