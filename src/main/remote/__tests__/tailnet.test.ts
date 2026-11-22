import { describe, expect, it } from 'vitest'
import { parseTailnetName, parseTailnetServeHostname } from '../tailnet'

describe('parseTailnetName', () => {
  it('reads the MagicDNS name of a running node', () => {
    expect(parseTailnetName(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'Desk-PC.tail1234.ts.net.' } }))).toBe('desk-pc.tail1234.ts.net')
  })
  it('ignores stopped nodes, foreign names and junk', () => {
    expect(parseTailnetName(JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'pc.tail1234.ts.net.' } }))).toBeNull()
    expect(parseTailnetName(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.example.com.' } }))).toBeNull()
    expect(parseTailnetName('not json')).toBeNull()
  })
})

describe('parseTailnetServeHostname', () => {
  const host = 'prodesk-home.tailff3893.ts.net'
  const serveStatus = (proxy = 'http://127.0.0.1:47900', path = '/ws', tls = true, serveHost = host) =>
    JSON.stringify({
      TCP: { '443': { HTTPS: tls } },
      Web: { [`${serveHost}:443`]: { Handlers: { [path]: { Proxy: proxy } } } },
    })

  it('returns the private MagicDNS host only for the active HTTPS /ws gateway proxy', () => {
    expect(parseTailnetServeHostname(serveStatus(), host, 47900)).toBe(host)
  })

  it('accepts the default HTTPS hostname form and rejects invalid gateway ports', () => {
    const status = JSON.stringify({
      TCP: { '443': { HTTPS: true } },
      Web: { [host]: { Handlers: { '/ws': { Proxy: 'http://127.0.0.1:47900' } } } },
    })
    expect(parseTailnetServeHostname(status, `${host.toUpperCase()}.`, 47900)).toBe(host)
    for (const port of [0, 65536, 1.5, Number.NaN]) expect(parseTailnetServeHostname(status, host, port)).toBeNull()
  })

  it('rejects a matching Serve route if Tailscale Funnel is enabled for that host and port', () => {
    const status = JSON.parse(serveStatus()) as { AllowFunnel?: Record<string, boolean> }
    status.AllowFunnel = { [`${host}:443`]: true }
    expect(parseTailnetServeHostname(JSON.stringify(status), host, 47900)).toBeNull()

    const foreground = JSON.parse(serveStatus()) as { Foreground?: Record<string, { AllowFunnel?: Record<string, boolean> }> }
    foreground.Foreground = { cli: { AllowFunnel: { [`${host}:443`]: true } } }
    expect(parseTailnetServeHostname(JSON.stringify(foreground), host, 47900)).toBeNull()

    const safe = JSON.parse(serveStatus()) as { AllowFunnel?: Record<string, boolean> }
    safe.AllowFunnel = { [`${host}:443`]: false, [`${host}:8443`]: true }
    expect(parseTailnetServeHostname(JSON.stringify(safe), host, 47900)).toBe(host)
  })

  it('fails closed for a wrong upstream, path, TLS listener, hostname or malformed status', () => {
    expect(parseTailnetServeHostname(serveStatus('http://127.0.0.1:47901'), host, 47900)).toBeNull()
    expect(parseTailnetServeHostname(serveStatus('http://127.0.0.1:47900', '/'), host, 47900)).toBeNull()
    expect(parseTailnetServeHostname(serveStatus('http://127.0.0.1:47900', '/ws', false), host, 47900)).toBeNull()
    expect(parseTailnetServeHostname(serveStatus('http://127.0.0.1:47900', '/ws', true, 'other.tailff3893.ts.net'), host, 47900)).toBeNull()
    expect(parseTailnetServeHostname(serveStatus('http://127.0.0.1:47900', '/ws', true, 'li.quoc.app'), host, 47900)).toBeNull()
    expect(parseTailnetServeHostname('not json', host, 47900)).toBeNull()
  })
})
