// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { base64UrlEncode, encodeWebPairLink } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { encodeKeyPair, MemoryDeviceKeyStore } from '../transport/device-keys'
import { HostSim, testKeyPair } from '../test/host-sim'
import { HostManager } from './HostManager'
import { activeTimeline, useWorkbench } from '../workbench/workbench-store'

const HOST_STATIC = testKeyPair('ee'.repeat(32))

function seedRecord(hostId: string, hostName: string, endpoints: string[]) {
  return {
    hostId,
    hostName,
    hostPub: base64UrlEncode(HOST_STATIC.pub),
    ...encodeKeyPair(generateKeyPair()),
    endpoints,
    createdAt: 1,
    lastConnectedAt: null,
    deviceId: null,
  }
}

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

    // Empty state has a single connect action (spec T1); it opens the host/pair dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Thêm host' }))
    fireEvent.change(screen.getByLabelText('Pair link'), { target: { value: encodeWebPairLink(offer) } })
    fireEvent.click(screen.getByRole('button', { name: 'Ghép nối' }))
    await waitFor(() => expect(() => sim.socket).not.toThrow())
    sim.socket.open()

    // Pair success drops the user into the workbench (dialog auto-closes).
    await waitFor(() => expect(screen.getByRole('button', { name: /Host: Laptop/ })).toBeTruthy())
    await waitFor(() => expect(screen.queryByTestId('host-dialog-backdrop')).toBeNull())
    await waitFor(() => expect(sim.pairTokens[0]).toBe(offer.pairToken))
    await waitFor(() => expect(useWorkbench.getState().slices.host_laptop?.state).toBe('online'))
    expect(useWorkbench.getState().slices.host_laptop?.ownerProtocol).toBe(1)
    expect(await keyStore.get('host_laptop')).toMatchObject({ hostId: 'host_laptop', deviceId: 'dev_web' })
    // Pair token is intentionally not part of the persisted device record.
    expect(JSON.stringify(await keyStore.get('host_laptop'))).not.toContain(offer.pairToken)

    // Temporary disconnect from the host dialog never deletes the device key (spec T1).
    fireEvent.click(screen.getByRole('button', { name: /Host: Laptop/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quản lý host' }))
    fireEvent.click(screen.getByRole('button', { name: 'Đóng tạm' }))
    await waitFor(() => expect(screen.getByText('Đã ngắt')).toBeTruthy())
    expect(await keyStore.get('host_laptop')).not.toBeNull()
  })

  it('keeps paired endpoint-error hosts visible and never shows the previous host timeline', async () => {
    const oldSessionKey = 'D:/project/old-session.jsonl'
    const keyStore = new MemoryDeviceKeyStore([
      seedRecord('host_laptop', 'Laptop', ['ws://100.64.0.2:47900/ws']),
      seedRecord('host_unavailable', 'Unavailable host', ['ws://example.com:47900/ws']),
    ])
    const sim = new HostSim({
      hostStatic: HOST_STATIC,
      hostId: 'host_laptop',
      hostName: 'Laptop',
      handlers: {
        'host.hello': () => ({ hostId: 'host_laptop', hostName: 'Laptop', version: '0.7.13', epoch: 'e_1', deviceId: 'dev_web', role: 'operator', features: [], assets: [], ownerProtocol: 1 }),
        'project.list': () => ({ projects: [{ id: 'D:/project', name: 'Project' }] }),
        'session.watchList': () => ({ sessions: [{ sessionKey: oldSessionKey, projectId: 'D:/project', title: 'Old private session marker', status: 'idle', updatedAt: 1 }] }),
        'session.unwatchList': () => ({}),
      },
    })
    render(<HostManager keyStore={keyStore} socketFactory={(url) => url.includes('100.64.0.2') ? sim.newSocket() as unknown as WebSocket : ({} as WebSocket)} />)
    await waitFor(() => expect(() => sim.socket).not.toThrow())
    sim.socket.open()
    await waitFor(() => expect(useWorkbench.getState().slices.host_laptop?.state).toBe('online'))
    await waitFor(() => expect(useWorkbench.getState().slices.host_laptop?.sessions[0]?.sessionKey).toBe(oldSessionKey))
    await waitFor(() => expect(useWorkbench.getState().slices.host_unavailable?.state).toBe('error'))

    useWorkbench.getState().selectSession('host_laptop', oldSessionKey)
    expect(screen.getByText('Old private session marker')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Host: Laptop/ }))
    const unavailableHost = screen.getByRole('menuitemradio', { name: /Unavailable host/ })
    expect(unavailableHost.textContent).toContain('Không có endpoint')
    fireEvent.click(unavailableHost)

    await waitFor(() => expect(useWorkbench.getState().activeHostId).toBe('host_unavailable'))
    expect(useWorkbench.getState().slices.host_unavailable?.state).toBe('error')
    expect(activeTimeline(useWorkbench.getState())).toBeNull()
    expect(screen.queryByText('Old private session marker')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('endpoint')
  })
})
