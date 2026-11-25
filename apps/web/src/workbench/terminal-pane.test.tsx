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
  lastOptions: null as Record<string, unknown> | null,
  termOptions: null as Record<string, unknown> | null,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    loadAddon() {}
    open() {}
    constructor(options?: Record<string, unknown>) {
      terminalState.lastOptions = options ?? null
      this.options = { ...(options ?? {}) }
      terminalState.termOptions = this.options
    }
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
  terminalState.lastOptions = null
  terminalState.termOptions = null
  document.documentElement.classList.remove('dark')
  localStorage.removeItem('lix-web-ui')
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

    // Spec T4: terminal palette follows the app theme — light app gets a white surface.
    document.documentElement.classList.remove('dark')

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

  it('terminal theme follows the app theme: white/black in light, dark surface in dark', async () => {
    const conn = { online: true, request: vi.fn(async () => ({ terminalId: 't', profile: 'bash' })), subscribeEvents: () => () => {} } as unknown as HostConnection

    document.documentElement.classList.remove('dark')
    const light = render(<TerminalPane sessionKey="s" conn={conn} />)
    await waitFor(() => expect(terminalState.lastOptions).not.toBeNull())
    expect((terminalState.lastOptions?.theme as { background: string }).background).toBe('#ffffff')
    expect((terminalState.lastOptions?.theme as { foreground: string }).foreground).toBe('#111111')
    light.unmount()

    document.documentElement.classList.add('dark')
    const dark = render(<TerminalPane sessionKey="s" conn={conn} />)
    await waitFor(() => expect((terminalState.lastOptions?.theme as { background: string }).background).toBe('#1f1f1f'))
    dark.unmount()
  })

  it('UAT R3: the topbar theme toggle repaints the live terminal without reopening the PTY', async () => {
    const open = vi.fn(async () => ({ terminalId: 't-flip', profile: 'bash' }))
    const conn = { online: true, request: open as unknown, subscribeEvents: () => () => {} } as unknown as HostConnection

    document.documentElement.classList.remove('dark')
    const view = render(<TerminalPane sessionKey="s" conn={conn} />)
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect((terminalState.lastOptions?.theme as { background: string }).background).toBe('#ffffff')

    // Owner flips the app to dark while the PTY stays open: palette must follow in place.
    document.documentElement.classList.add('dark')
    await waitFor(() => expect((terminalState.termOptions?.theme as { background?: string }).background).toBe('#1f1f1f'))
    document.documentElement.classList.remove('dark')
    await waitFor(() => expect((terminalState.termOptions?.theme as { background?: string }).background).toBe('#ffffff'))
    expect(open).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('UAT R3: a stored dark preference wins over the default light palette', async () => {
    localStorage.setItem('lix-web-ui', JSON.stringify({ state: { theme: 'dark' } }))
    const conn = { online: true, request: vi.fn(async () => ({ terminalId: 't-dark', profile: 'bash' })), subscribeEvents: () => () => {} } as unknown as HostConnection
    const view = render(<TerminalPane sessionKey="s" conn={conn} />)
    await waitFor(() => expect((terminalState.lastOptions?.theme as { background: string }).background).toBe('#1f1f1f'))
    view.unmount()
  })
})
