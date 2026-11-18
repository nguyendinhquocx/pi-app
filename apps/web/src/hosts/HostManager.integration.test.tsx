// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { base64UrlEncode, encodeWebPairLink } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { MemoryDeviceKeyStore } from '../transport/device-keys'
import { HostSim, testKeyPair } from '../test/host-sim'
import { HostManager } from './HostManager'
import { useWorkbench } from '../workbench/workbench-store'

const HOST_STATIC = testKeyPair('ee'.repeat(32))

afterEach(cleanup)
beforeEach(() => useWorkbench.setState({ slices: {}, activeHostId: null, notice: null }))

describe('HostManager → mounted Workbench integration (T3/T4 seam)', () => {
  it('pair link persists key, sends one-time pair token, and mounts the actual workbench after handshake', async () => {
    const keyStore = new MemoryDeviceKeyStore()
    const sim = new HostSim({
      hostStatic: HOST_STATIC,
      hostId: 'host_laptop',
      hostName: 'Laptop',
      handlers: {
        'host.hello': () => ({
          hostId: 'host_laptop', hostName: 'Laptop', version: '0.7.13', epoch: 'e_1', deviceId: 'dev_web',
          role: 'operator', features: [], assets: [], ownerProtocol: 1,
        }),
        'project.list': () => ({ projects: [{ id: 'D:/project', name: 'Project' }] }),
        'session.watchList': () => ({ sessions: [] }),
        'session.unwatchList': () => ({}),
      },
    })
    const offer = {
      v: 1 as const,
      hostId: 'host_laptop',
      hostName: 'Laptop',
      hostPub: base64UrlEncode(HOST_STATIC.pub),
      endpoints: ['ws://100.64.0.2:47900/ws'],
      pairToken: 'one-time-pair-token-123',
      exp: Date.now() + 60_000,
    }
    render(<HostManager keyStore={keyStore} socketFactory={() => sim.newSocket() as unknown as WebSocket} />)

    fireEvent.change(screen.getByLabelText('Pair link'), { target: { value: encodeWebPairLink(offer) } })
    fireEvent.click(screen.getByRole('button', { name: 'Ghép nối' }))
    await waitFor(() => expect(() => sim.socket).not.toThrow())
    sim.socket.open()

    await waitFor(() => expect(screen.getByLabelText('Hosts')).toBeTruthy())
    await waitFor(() => expect(sim.pairTokens[0]).toBe(offer.pairToken))
    await waitFor(() => expect(useWorkbench.getState().slices.host_laptop?.state).toBe('online'))
    expect(useWorkbench.getState().slices.host_laptop?.ownerProtocol).toBe(1)
    expect(await keyStore.get('host_laptop')).toMatchObject({ hostId: 'host_laptop', deviceId: 'dev_web' })
    // Pair token is intentionally not part of the persisted device record.
    expect(JSON.stringify(await keyStore.get('host_laptop'))).not.toContain(offer.pairToken)
  })
})
