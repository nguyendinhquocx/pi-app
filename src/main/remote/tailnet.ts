import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isPrivateHost } from '@shared/remote'

/** Where the Tailscale CLI lives when it is not on PATH (GUI installs). */
function candidates(): string[] {
  if (process.platform === 'win32') return [`${process.env.ProgramFiles || 'C:\\Program Files'}\\Tailscale\\tailscale.exe`, 'tailscale.exe']
  if (process.platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', 'tailscale']
  return ['tailscale']
}

function run(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 3000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
  })
}

/** Parse `tailscale status --json`: this machine's MagicDNS name, when it is online. */
export function parseTailnetName(json: string): string | null {
  try {
    const status = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string; Online?: boolean } }
    if (status.BackendState && status.BackendState !== 'Running') return null
    const name = status.Self?.DNSName?.replace(/\.$/, '').toLowerCase()
    return name && isPrivateHost(name) ? name : null
  } catch {
    return null
  }
}

/**
 * Return the node's MagicDNS hostname only when Tailscale Serve has the exact private HTTPS route
 * required by Li Web: `/ws` over TLS on 443 to the local gateway port. Similar-looking, stale, or
 * public routes are deliberately ignored so the browser never gets a dead or broader endpoint.
 */
type ServeStatusConfig = {
  AllowFunnel?: Record<string, boolean>
  Foreground?: Record<string, ServeStatusConfig>
  TCP?: Record<string, { HTTPS?: boolean }>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

function normalizeServeHostPort(value: string): string {
  const match = /^([^:]+):(\d+)$/.exec(value)
  if (!match) return value.toLowerCase()
  return `${match[1].replace(/\.$/, '').toLowerCase()}:${Number(match[2])}`
}

function funnelEnabledFor(config: ServeStatusConfig, hostPort: string): boolean {
  if (Object.entries(config.AllowFunnel ?? {}).some(([key, allowed]) => allowed === true && normalizeServeHostPort(key) === hostPort)) return true
  return Object.values(config.Foreground ?? {}).some((foreground) => funnelEnabledFor(foreground, hostPort))
}

/**
 * Return the node's MagicDNS hostname only when Tailscale Serve has the exact private HTTPS route
 * required by Li Web: `/ws` over TLS on 443 to the local gateway port. Similar-looking, stale, public,
 * or Funnel-enabled routes are deliberately ignored so the browser never gets a broader endpoint.
 */
export function parseTailnetServeHostname(json: string, expectedHostname: string, gatewayPort: number): string | null {
  try {
    const hostname = expectedHostname.replace(/\.$/, '').toLowerCase()
    if (!hostname.endsWith('.ts.net') || !isPrivateHost(hostname)) return null
    if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) return null

    const status = JSON.parse(json) as ServeStatusConfig
    if (status.TCP?.['443']?.HTTPS !== true) return null
    const hostPort = `${hostname}:443`
    if (funnelEnabledFor(status, hostPort)) return null
    const expectedProxy = `http://127.0.0.1:${gatewayPort}`

    for (const [address, web] of Object.entries(status.Web ?? {})) {
      const match = /^([^:]+)(?::(\d+))?$/.exec(address)
      if (!match) continue
      const configuredHost = match[1].replace(/\.$/, '').toLowerCase()
      const configuredPort = match[2] ?? '443'
      if (configuredHost !== hostname || configuredPort !== '443') continue
      if (web.Handlers?.['/ws']?.Proxy === expectedProxy) return hostname
    }
    return null
  } catch {
    return null
  }
}

/** This machine's Tailscale MagicDNS name (`pc.tail1234.ts.net`), or null without a running Tailscale. */
export async function detectTailnetName(): Promise<string | null> {
  for (const bin of candidates()) {
    if (bin.includes('/') || bin.includes('\\')) {
      if (!existsSync(bin)) continue
    }
    const out = await run(bin, ['status', '--json', '--peers=false'])
    if (out) return parseTailnetName(out)
  }
  return null
}

/** Current verified Serve hostname for this gateway, or null when the exact route is inactive. */
export async function detectTailnetServeHostname(expectedHostname: string | null, gatewayPort: number): Promise<string | null> {
  if (!expectedHostname) return null
  for (const bin of candidates()) {
    if (bin.includes('/') || bin.includes('\\')) {
      if (!existsSync(bin)) continue
    }
    const out = await run(bin, ['serve', 'status', '--json'])
    if (out) return parseTailnetServeHostname(out, expectedHostname, gatewayPort)
  }
  return null
}
