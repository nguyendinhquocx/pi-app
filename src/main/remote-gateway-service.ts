import QRCode from 'qrcode'
import type { Role } from '@shared/remote'
import { RemoteGateway, type GatewayStatus } from './remote/gateway'
import { createElectronRemoteHost } from './remote-host-electron'
import { detectTailnetName, detectTailnetServeHostname } from './remote/tailnet'

/**
 * Owns the single RemoteGateway: created lazily, started when the user enables it (or at boot
 * if it was left on), stopped on disable / quit. While off nothing listens and every tap is a no-op.
 */

let gateway: RemoteGateway | null = null
let serveHostname: string | null = null

function instance(): RemoteGateway {
  if (!gateway) gateway = new RemoteGateway(createElectronRemoteHost(() => serveHostname))
  return gateway
}

const TAILNET_TTL_MS = 60_000
let tailnetCheckedAt = 0
let tailnetRefresh: Promise<void> | null = null

/** Refresh MagicDNS + the exact active Serve route at most once a minute; overlapping callers share the same probe. */
async function refreshTailnet(gw: RemoteGateway): Promise<void> {
  if (tailnetRefresh) return tailnetRefresh
  if (Date.now() - tailnetCheckedAt < TAILNET_TTL_MS) return

  const refresh = (async () => {
    const tailnetName = await detectTailnetName().catch(() => null)
    gw.tailnetName = tailnetName
    serveHostname = await detectTailnetServeHostname(tailnetName, gw.boundPort).catch(() => null)
    tailnetCheckedAt = Date.now()
  })()
  tailnetRefresh = refresh
  try {
    await refresh
  } finally {
    if (tailnetRefresh === refresh) tailnetRefresh = null
  }
}

export type RemoteStatus = GatewayStatus & { qrSvg?: string }

async function withQr(status: GatewayStatus): Promise<RemoteStatus> {
  if (!status.pairing) return status
  const qrSvg = await QRCode.toString(status.pairing.link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  return { ...status, qrSvg }
}

export async function startRemoteGatewayIfEnabled(): Promise<void> {
  const gw = instance()
  if (!gw.auth.config.enabled) return
  try {
    await gw.start()
    void refreshTailnet(gw)
  } catch (error) {
    console.warn('[remote] gateway failed to start:', error)
  }
}

export async function stopRemoteGateway(): Promise<void> {
  await gateway?.stop()
}

export async function remoteStatus(): Promise<RemoteStatus> {
  const gw = instance()
  if (gw.listening) await refreshTailnet(gw)
  return withQr(gw.status(gw.auth.config.enabled))
}

export async function setRemoteEnabled(enabled: boolean): Promise<RemoteStatus> {
  const gw = instance()
  gw.auth.setEnabled(enabled)
  if (enabled) {
    try {
      await gw.start()
      if (!gw.auth.currentPairing) gw.regeneratePairing()
    } catch {
      /* status carries the error */
    }
  } else await gw.stop()
  return remoteStatus()
}

export async function setRemotePort(port: number): Promise<RemoteStatus> {
  const gw = instance()
  gw.auth.setPort(port)
  if (gw.listening) {
    await gw.stop()
    try {
      await gw.start()
      gw.regeneratePairing()
    } catch {
      /* status carries the error */
    }
  }
  return remoteStatus()
}

export async function regenerateRemotePairing(): Promise<RemoteStatus> {
  const gw = instance()
  if (gw.listening) gw.regeneratePairing()
  return remoteStatus()
}

export async function setRemoteProjects(projects: string[]): Promise<RemoteStatus> {
  instance().auth.setProjects(projects)
  return remoteStatus()
}

export async function revokeRemoteDevice(id: string): Promise<RemoteStatus> {
  instance().revokeDevice(id)
  return remoteStatus()
}

export async function removeRemoteDevice(id: string): Promise<RemoteStatus> {
  instance().removeDevice(id)
  return remoteStatus()
}

export async function setRemoteDeviceRole(id: string, role: Role): Promise<RemoteStatus> {
  instance().setDeviceRole(id, role)
  return remoteStatus()
}
