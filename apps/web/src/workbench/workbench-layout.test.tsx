// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostConnection } from '../transport/host-connection'
import { Workbench, INSPECTOR_MAX, LAYOUT_KEY, MIN_CENTER_WIDTH, RAIL_MIN, RAIL_MAX, RESIZE_GUTTER, loadLayout, resolveWorkbenchWidths } from './Workbench'
import { emptyTimeline } from './timeline-store'
import { useWorkbench } from './workbench-store'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    write() {}
    onData() { return { dispose() {} } }
    onResize() { return { dispose() {} } }
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

/**
 * Spec T2 acceptance: collapse/expand + keyboard resize with local-only persistence; mobile
 * session drawer Escape/focus-return; collapse never drops the selected session.
 */

const fakeConn = {
  hostId: 'h1',
  state: 'online',
  online: true,
  errorDetail: null,
  hello: { hostId: 'h1', hostName: 'Laptop', role: 'operator', ownerProtocol: 1 },
  bindEvents() {},
  start() {},
  stop() {},
  dispose() {},
  subscribeEvents() { return () => {} },
  request: async (method: string) => {
    if (method === 'terminal.open') return { terminalId: 'layout-test-terminal' }
    if (method === 'session.watchList') return { sessions: [] }
    if (method === 'project.list') return { projects: [] }
    if (method === 'session.stats') return {}
    if (method === 'command.list') return { commands: [] }
    if (method === 'model.list') return { models: [], current: null, thinking: null, availableThinking: [] }
    if (method === 'session.branches') return { branches: [] }
    return {}
  },
} as unknown as HostConnection

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

function seedStore(selectedSessionKey: string | null): void {
  useWorkbench.setState({
    activeHostId: 'h1',
    notice: null,
    slices: {
      h1: {
        state: 'online', detail: null, role: 'operator', ownerProtocol: 1,
        projects: [], selectedProjectId: null,
        sessions: [],
        selectedSessionKey,
        timelines: selectedSessionKey ? { [selectedSessionKey]: emptyTimeline() } : {},
      },
    },
  })
}

beforeEach(() => {
  setViewport(1024)
  localStorage.clear()
  seedStore(null)
})
afterEach(() => {
  cleanup()
  setViewport(1024)
})

describe('Workbench layout (spec T2: rails collapse/resize/persist)', () => {
  it('defaults: rail open, inspector closed; toggles flip aria-expanded and persist', () => {
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} />)
    const railToggle = screen.getByRole('button', { name: 'Thu gọn danh sách phiên' })
    expect(railToggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.workbench-main')?.className).toContain('rail-open')

    fireEvent.click(railToggle)
    expect(railToggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.workbench-main')?.className).toContain('rail-closed')
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}').railOpen).toBe(false)
  })

  it('respects saved preferences and dynamically clamps widths to keep the desktop center readable', async () => {
    seedStore('proj/s1.jsonl')
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ railOpen: true, railWidth: 999, inspectorOpen: true, inspectorWidth: 300 }))
    expect(loadLayout().railWidth).toBe(RAIL_MAX)
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} />)
    const sep = screen.getByRole('separator', { name: 'Độ rộng panel phiên' })
    const resolved = resolveWorkbenchWidths(loadLayout(), window.innerWidth)
    expect(sep.getAttribute('aria-valuenow')).toBe(String(resolved.railWidth))
    expect(sep.getAttribute('aria-valuemax')).toBe(String(resolved.railMax))
    const main = document.querySelector('.workbench-main') as HTMLElement
    expect(main.style.getPropertyValue('--inspector-w')).toBe(`${resolved.inspectorWidth}px`)
    const gutters = window.innerWidth >= 1025 ? (2 * RESIZE_GUTTER) : 0
    expect(resolved.railWidth + resolved.inspectorWidth + MIN_CENTER_WIDTH + gutters).toBeLessThanOrEqual(window.innerWidth)
  })

  it('resolves each breakpoint without forcing the mobile main pane to 360px', () => {
    const requested = { railOpen: true, railWidth: RAIL_MAX, inspectorOpen: true, inspectorWidth: INSPECTOR_MAX }
    for (const width of [769, 999]) {
      const resolved = resolveWorkbenchWidths(requested, width)
      expect(resolved.railWidth + MIN_CENTER_WIDTH).toBeLessThanOrEqual(width)
      expect(resolved.inspectorWidth).toBeLessThanOrEqual(Math.floor(width * 0.44))
    }
    for (const width of [1000, 1024]) {
      const resolved = resolveWorkbenchWidths(requested, width)
      expect(resolved.railWidth + resolved.inspectorWidth + MIN_CENTER_WIDTH).toBeLessThanOrEqual(width)
    }
    for (const width of [1025, 1440]) {
      const resolved = resolveWorkbenchWidths(requested, width)
      expect(resolved.railWidth + resolved.inspectorWidth + MIN_CENTER_WIDTH + 2 * RESIZE_GUTTER).toBeLessThanOrEqual(width)
    }
  })

  it('separator keyboard resize: Arrow keys move, Home/End clamp to the viewport-aware max', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ railOpen: true, railWidth: 280, inspectorOpen: false, inspectorWidth: 310 }))
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} />)
    const sep = screen.getByRole('separator', { name: 'Độ rộng panel phiên' })
    const maxWidth = resolveWorkbenchWidths(loadLayout(), window.innerWidth).railMax
    expect(sep.getAttribute('aria-valuemin')).toBe(String(RAIL_MIN))
    expect(sep.getAttribute('aria-valuemax')).toBe(String(maxWidth))

    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(sep.getAttribute('aria-valuenow')).toBe('256')
    fireEvent.keyDown(sep, { key: 'Home' })
    expect(sep.getAttribute('aria-valuenow')).toBe(String(RAIL_MIN))
    fireEvent.keyDown(sep, { key: 'End' })
    expect(sep.getAttribute('aria-valuenow')).toBe(String(maxWidth))
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}').railWidth).toBe(maxWidth)
  })

  it('pointer resize stops cleanly when the browser cancels the drag', () => {
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} />)
    const separator = screen.getByRole('separator', { name: 'Độ rộng panel phiên' })
    const dispatchPointer = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      act(() => { fireEvent(separator, event) })
    }

    dispatchPointer('pointerdown', 100)
    dispatchPointer('pointermove', 124)
    expect(separator.getAttribute('aria-valuenow')).toBe('304')

    dispatchPointer('pointercancel', 124)
    dispatchPointer('pointermove', 180)
    expect(separator.getAttribute('aria-valuenow')).toBe('304')
  })

  it('mobile session drawer traps focus, Escape closes and focus returns to the toggle', () => {
    setViewport(375)
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} />)
    const toggle = screen.getByRole('button', { name: 'Mở danh sách phiên' })
    toggle.focus()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const drawer = screen.getByRole('dialog', { name: 'Sessions on h1' })
    expect(drawer.className).toContain('mobile-visible')
    expect(document.querySelector('.session-scrim')).toBeTruthy()
    const focusable = drawer.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled])')
    focusable[focusable.length - 1].focus()
    fireEvent.keyDown(focusable[focusable.length - 1], { key: 'Tab' })
    expect(document.activeElement).toBe(focusable[0])

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
  })

  it('Inspector opens as a modal mobile sheet, traps focus, Escape closes and returns focus', async () => {
    setViewport(375)
    seedStore('proj/s1.jsonl')
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mở Inspector' })).toBeTruthy())
    const toggle = screen.getByRole('button', { name: 'Mở Inspector' })
    toggle.focus()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.inspector-scrim')).toBeTruthy()
    const dialog = screen.getByRole('dialog', { name: 'Inspector' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const terminalTab = screen.getByRole('tab', { name: 'Terminal' })
    expect(terminalTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(terminalTab)
    const focusable = dialog.querySelectorAll<HTMLElement>('button:not([disabled])')
    focusable[focusable.length - 1].focus()
    fireEvent.keyDown(focusable[focusable.length - 1], { key: 'Tab' })
    expect(document.activeElement).toBe(focusable[0])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
  })

  it('keeps the host picker reachable when the rail collapses and in the mobile drawer', () => {
    setViewport(375)
    const hostPicker = <button aria-label="Host: Laptop">Laptop</button>
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} hostPicker={hostPicker} />)
    const picker = screen.getByRole('button', { name: 'Host: Laptop' })
    expect(document.querySelector('.session-rail')?.contains(picker)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Thu gọn danh sách phiên' }))
    const desktopToggle = document.querySelector('.rail-toggle') as HTMLButtonElement
    expect(desktopToggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(desktopToggle)
    expect(document.querySelector('.workbench-main')?.className).toContain('rail-open')

    const mobileToggle = document.querySelector('.mobile-session-toggle') as HTMLButtonElement
    fireEvent.click(mobileToggle)
    const mobileRail = document.querySelector('.session-rail.mobile-visible')
    expect(mobileRail?.contains(picker)).toBe(true)
  })

  it('inspector toggle appears with a session and collapses independently of the rail', async () => {
    seedStore('proj/s1.jsonl')
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mở Inspector' })).toBeTruthy())
    const inspectorToggle = screen.getByRole('button', { name: 'Mở Inspector' })
    expect(inspectorToggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(inspectorToggle)
    expect(document.querySelector('.workbench-main')?.className).toContain('inspector-open')
    expect(document.querySelector('.inspector')).toBeTruthy()

    // Collapsing the rail keeps the session selected (spec T2 acceptance).
    fireEvent.click(screen.getByRole('button', { name: 'Thu gọn danh sách phiên' }))
    expect(useWorkbench.getState().slices.h1.selectedSessionKey).toBe('proj/s1.jsonl')
    expect(document.querySelector('.workbench-main')?.className).toContain('inspector-open')
  })
})
