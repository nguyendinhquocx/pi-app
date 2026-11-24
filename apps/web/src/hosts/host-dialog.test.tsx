// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { base64UrlEncode } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { encodeKeyPair, MemoryDeviceKeyStore } from '../transport/device-keys'
import { testKeyPair } from '../test/host-sim'
import { HostManager } from './HostManager'

/**
 * Spec T1 acceptance: dialog semantics (Escape/backdrop/close + focus return), Forget requires
 * explicit confirmation and actually deletes only the browser device key, empty state has one
 * connect action, document shell is "Li" without the old "Li Web" header.
 */

const HOST_STATIC = testKeyPair('dd'.repeat(32))

function seedRecord(hostId: string, hostName: string) {
  const kp = encodeKeyPair(generateKeyPair())
  return {
    hostId,
    hostName,
    hostPub: base64UrlEncode(HOST_STATIC.pub),
    ...kp,
    endpoints: ['ws://100.64.0.9:47900/ws'],
    createdAt: 1,
    lastConnectedAt: null,
    deviceId: null,
  }
}

// Sockets never open in these tests — host management is purely local UI behavior.
const neverSocket = () => ({}) as unknown as WebSocket

afterEach(cleanup)
beforeEach(() => {
  document.title = 'Li'
})

async function openDialog(tab: 'hosts' | 'pair' = 'pair'): Promise<void> {
  const picker = screen.queryByRole('button', { name: /^Host:/ })
  if (tab === 'hosts') {
    const hostPicker = picker ?? await screen.findByRole('button', { name: /^Host:/ })
    fireEvent.click(hostPicker)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Quản lý host' }))
    return
  }
  if (picker) {
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('menuitem', { name: /Thêm host/ }))
    return
  }
  fireEvent.click(screen.getByRole('button', { name: 'Thêm host' }))
}

describe('Host shell (spec T1: Li shell + host dialog semantics)', () => {
  it('empty state has a single connect action and no "Li Web" heading', () => {
    render(<HostManager keyStore={new MemoryDeviceKeyStore()} socketFactory={neverSocket} />)
    expect(document.querySelector('h1')).toBeNull()
    expect(document.body.textContent).not.toContain('Pi workbench trên các host')
    expect(screen.getAllByRole('button', { name: 'Thêm host' })).toHaveLength(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dialog opens, closes on Escape and returns focus to the trigger', async () => {
    render(<HostManager keyStore={new MemoryDeviceKeyStore()} socketFactory={neverSocket} />)
    const trigger = screen.getByRole('button', { name: 'Thêm host' })
    // A real click leaves focus on the trigger; mirror that before opening.
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByLabelText('Pair link')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('paired-host and pair panels are tabs, not separate preview routes', async () => {
    render(<HostManager keyStore={new MemoryDeviceKeyStore()} socketFactory={neverSocket} />)
    await openDialog('pair')
    expect(screen.getByLabelText('Pair link')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Đã ghép nối' }))
    expect(screen.getByText('Chưa có host đã ghép nối.')).toBeTruthy()
    expect(screen.queryByLabelText('Pair link')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Ghép nối mới' }))
    expect(screen.getByLabelText('Pair link')).toBeTruthy()
  })

  it('dialog closes on backdrop click and via the close button', async () => {
    render(<HostManager keyStore={new MemoryDeviceKeyStore()} socketFactory={neverSocket} />)
    await openDialog()
    fireEvent.mouseDown(screen.getByTestId('host-dialog-backdrop'))
    expect(screen.queryByRole('dialog')).toBeNull()

    await openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Đóng' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('invalid pair link surfaces an error with role=alert inside the dialog', async () => {
    render(<HostManager keyStore={new MemoryDeviceKeyStore()} socketFactory={neverSocket} />)
    await openDialog()
    fireEvent.change(screen.getByLabelText('Pair link'), { target: { value: 'not-a-pair-link' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ghép nối' }))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Không phải pair link')
  })

  it('Forget requires confirmation: cancel keeps the device key, confirm deletes it', async () => {
    const keyStore = new MemoryDeviceKeyStore([seedRecord('host_laptop', 'Laptop')])
    render(<HostManager keyStore={keyStore} socketFactory={neverSocket} />)
    await openDialog('hosts')
    // Host list lives inside the dialog and loads asynchronously.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Quên Laptop' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Quên Laptop' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Xác nhận quên Laptop' })
    expect(confirm).toBeTruthy()

    // Cancel path: the device key must survive.
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(keyStore.get('host_laptop')).resolves.not.toBeNull())

    // Confirm path: only then is the browser device key deleted.
    fireEvent.click(screen.getByRole('button', { name: 'Quên Laptop' }))
    fireEvent.click(screen.getByRole('alertdialog', { name: 'Xác nhận quên Laptop' }).querySelector('.danger') as HTMLElement)
    await waitFor(() => expect(keyStore.get('host_laptop')).resolves.toBeNull())
    expect(await keyStore.get('host_laptop')).toBeNull()
  })
})
