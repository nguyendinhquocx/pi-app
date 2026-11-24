import React from 'react'
import ReactDOM from 'react-dom/client'
import { base64UrlEncode } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { encodeKeyPair, MemoryDeviceKeyStore, type DeviceKeyRecord } from '../transport/device-keys'
import { testKeyPair } from '../test/host-sim'
import { HostManager } from '../hosts/HostManager'
import './workbench-preview.css'
import '../styles.css'

/**
 * Host/pair dialog fixture (spec T5): renders the real HostManager shell against a
 * MemoryDeviceKeyStore and a socket factory that never opens. No pair token, no real host,
 * no camera. Used for visual QA of the dialog states (host list, pair input, errors).
 */

const HOST_STATIC = testKeyPair('ee'.repeat(32))

function seed(hostId: string, hostName: string, endpoints: string[]): DeviceKeyRecord {
  const kp = encodeKeyPair(generateKeyPair())
  return {
    hostId,
    hostName,
    hostPub: base64UrlEncode(HOST_STATIC.pub),
    ...kp,
    endpoints,
    createdAt: 1,
    lastConnectedAt: null,
    deviceId: null,
  }
}

const keyStore = new MemoryDeviceKeyStore([
  seed('host_laptop', 'Laptop (demo)', ['ws://100.64.0.2:47900/ws']),
  seed('host_desk', 'ProDesk (demo)', ['ws://100.64.0.9:47900/ws']),
])

// Sockets never open in the fixture — the dialog stays in its disconnected/connecting states.
const deadSocket = () => ({}) as unknown as WebSocket

ReactDOM.createRoot(document.getElementById('root')!).render(
  <>
    <div className="fixture-banner">LOCAL UI FIXTURE — host/pair dialog with synthetic hosts, no pair token</div>
    <HostManager keyStore={keyStore} socketFactory={deadSocket} initialDialogOpen />
  </>,
)
