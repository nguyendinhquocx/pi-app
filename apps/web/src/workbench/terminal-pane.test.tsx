// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalPane } from './Inspector'
import type { HostConnection } from '../transport/host-connection'

const terminalState = vi.hoisted(() => ({
  writes: [] as string[],
  onData: null as null | ((data: string) => void),
  onResize: null as null | ((size: { cols: number; rows: number }) => void),
  disposed: false,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    write(text: string) { terminalState.writes.push(text) }
    onData(callback: (data: string) => void) { terminalState.onData = callback; return { dispose() {} } }
    onResize(callback: (size: { cols: number; rows: number }) => void) { terminalState.onResize = callback; return { dispose() {} } }
    dispose() { terminalState.disposed = true }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} dispose() {} } }))

afterEach(() => {
  cleanup()
  terminalState.writes = []
  terminalState.onData = null
  terminalState.onResize = null
  terminalState.disposed = false
})

describe('TerminalPane wire integration (T4: remote PTY + OSC 52 off)', () => {
  it('subscribes to terminal.data/exit, strips OSC 52 before xterm.write, forwards input/resize, closes on unmount', async () => {
    const requests: { method: string; params: unknown }[] = []
    type TerminalListener = (event: 'terminal.data' | 'terminal.exit', payload: { terminalId: string; data?: string; code?: number }) => void
    const bus: { listener: TerminalListener | null } = { listener: null }
    let unsubscribed = false
    const conn = {
      online: true,
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params })
        if (method === 'terminal.open') return { terminalId: 'terminal-1', profile: 'bash' }
        return {}
      }),
      subscribeEvents(listener: TerminalListener) {
        bus.listener = listener
        return () => { unsubscribed = true }
      },
    } as unknown as HostConnection

    const view = render(<TerminalPane sessionKey="proj/s.jsonl" conn={conn} />)
    await waitFor(() => expect(requests.some((request) => request.method === 'terminal.open')).toBe(true))

    bus.listener?.('terminal.data', { terminalId: 'terminal-1', data: '\x1b]52;c;c2VjcmV0\x07VISIBLE\r\n' })
    expect(terminalState.writes.join('')).toBe('VISIBLE\r\n')

    terminalState.onData?.('pwd\r')
    terminalState.onResize?.({ cols: 100, rows: 30 })
    await waitFor(() => expect(requests.map((request) => request.method)).toEqual(['terminal.open', 'terminal.input', 'terminal.resize']))

    bus.listener?.('terminal.exit', { terminalId: 'terminal-1', code: 0 })
    await waitFor(() => expect(view.container.querySelector('[data-status="exited"]')).toBeTruthy())

    view.unmount()
    await waitFor(() => expect(requests.some((request) => request.method === 'terminal.close')).toBe(true))
    expect(unsubscribed).toBe(true)
    expect(terminalState.disposed).toBe(true)
  })
})
