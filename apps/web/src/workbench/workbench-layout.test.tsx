// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostConnection } from '../transport/host-connection'
import { Workbench, INSPECTOR_MAX, LAST_HOST_KEY, LAYOUT_KEY, MIN_CENTER_WIDTH, RAIL_MIN, RAIL_MAX, RESIZE_GUTTER, loadLayout, resolveWorkbenchWidths } from './Workbench'
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
  hasSessionOpenListener: () => false,
  openSessionTracked: async (sessionKey: string) => ({ current: true, result: { sessionKey, title: sessionKey, epoch: 'e_1', seq: 0, kind: 'snapshot', turns: [], state: { running: false }, pendingUi: [] } }),
  closeSession: async () => ({}),
  start() {},
  stop() {},
  dispose() {},
  subscribeEvents() { return () => {} },
  subscribeState() { return () => {} },
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
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ railOpen: true, railWidth: RAIL_MAX + 999, inspectorOpen: true, inspectorWidth: 300 }))
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

  it('UAT R3: the Inspector is resizable up to half the viewport, center floor intact', () => {
    // Terminal-first usage: stored width beyond the legacy cap now reaches half the viewport.
    for (const width of [1025, 1280, 1440]) {
      const resolved = resolveWorkbenchWidths({ railOpen: false, railWidth: 280, inspectorOpen: true, inspectorWidth: 1000 }, width)
      expect(resolved.inspectorWidth).toBe(Math.floor(width / 2))
    }
    const withRail = resolveWorkbenchWidths({ railOpen: true, railWidth: 280, inspectorOpen: true, inspectorWidth: 1000 }, 1025)
    expect(withRail.inspectorWidth).toBeLessThanOrEqual(Math.floor(1025 / 2))
    expect(withRail.railWidth + withRail.inspectorWidth + MIN_CENTER_WIDTH + 2 * RESIZE_GUTTER).toBeLessThanOrEqual(1025)
  })

  it('UAT R3: the new-session view keeps the Inspector toggle and composer at the bottom, no landing copy', () => {
    seedStore(null)
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} />)
    expect(screen.getByRole('button', { name: 'Mở Inspector' })).toBeTruthy()
    expect(screen.queryByText('Phiên mới')).toBeNull()
    expect(screen.queryByText('Chưa có nội dung — gửi tin nhắn đầu tiên.')).toBeNull()
    expect(screen.getByLabelText('Tin nhắn')).toBeTruthy()
    const empty = document.querySelector('.empty-session') as HTMLElement | null
    expect(empty).not.toBeNull()
  })

  it('UAT R3: reload restores the last used host instead of the first connection', async () => {
    seedStore(null)
    useWorkbench.setState({ activeHostId: null })
    localStorage.setItem(LAST_HOST_KEY, 'h2')
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }, { hostId: 'h2', conn: fakeConn }]} />)
    await waitFor(() => expect(useWorkbench.getState().activeHostId).toBe('h2'))
  })

  it('UAT R4: a saved host whose connection appears later wins over the auto first-host fallback', async () => {
    seedStore(null)
    useWorkbench.setState({ activeHostId: null })
    localStorage.setItem(LAST_HOST_KEY, 'laptop')
    const view = render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }]} />)
    await waitFor(() => expect(useWorkbench.getState().activeHostId).toBe('h1'))
    // Auto fallback must not clobber the saved host memory.
    expect(localStorage.getItem(LAST_HOST_KEY)).toBe('laptop')
    view.rerender(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }, { hostId: 'laptop', conn: fakeConn }]} />)
    await waitFor(() => expect(useWorkbench.getState().activeHostId).toBe('laptop'))
  })

  it('UAT R4: chooseHost persists a deliberate pick; auto fallback never writes the memory', async () => {
    seedStore(null)
    useWorkbench.setState({ activeHostId: null })
    render(<Workbench connections={[{ hostId: 'h1', conn: fakeConn }, { hostId: 'h2', conn: fakeConn }]} />)
    await waitFor(() => expect(useWorkbench.getState().activeHostId).toBe('h1'))
    expect(localStorage.getItem(LAST_HOST_KEY)).toBeNull()
    useWorkbench.getState().chooseHost('h2')
    expect(useWorkbench.getState().activeHostId).toBe('h2')
    expect(localStorage.getItem(LAST_HOST_KEY)).toBe('h2')
  })

  it('UAT R4: the new-session model picker lists host models (borrowed key) and remembers the pick', async () => {
    seedStore(null)
    useWorkbench.setState({
      activeHostId: 'h1',
      slices: {
        h1: {
          state: 'online', detail: null, role: 'operator', ownerProtocol: 1,
          projects: [], selectedProjectId: null,
          sessions: [{ sessionKey: 'proj/a.jsonl', projectId: 'p1', title: 'A', status: 'idle' as const, updatedAt: 1 }],
          selectedSessionKey: null,
          timelines: {},
        },
      },
    })
    const modelConn = {
      ...fakeConn,
      request: async (method: string) => {
        if (method === 'session.watchList') return { sessions: [{ sessionKey: 'proj/a.jsonl', projectId: 'p1', title: 'A', status: 'idle', updatedAt: 1 }] }
        if (method === 'model.list') return { models: [{ id: 'model-x', name: 'Model X', provider: 'test', group: 'custom' }], current: null, thinking: null, availableThinking: [] }
        if (method === 'session.stats') return {}
        if (method === 'command.list') return { commands: [] }
        if (method === 'session.branches') return { branches: [] }
        return {}
      },
    } as unknown as HostConnection
    render(<Workbench connections={[{ hostId: 'h1', conn: modelConn }]} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Model:/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Model:/ }))
    const search = await screen.findByLabelText('Tìm model')
    fireEvent.change(search, { target: { value: 'Model X' } })
    const option = await screen.findByRole('option', { name: /Model X/ })
    fireEvent.click(option)
    // Selection shows on the trigger (applied to the session created by the first message).
    await waitFor(() => expect(screen.getByRole('button', { name: /Model: Model X/ })).toBeTruthy())
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
    const dialog = screen.getByRole('dialog', { name: 'Terminal' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(document.activeElement).toBe(dialog)
    const focusable = dialog.querySelectorAll<HTMLElement>('button:not([disabled])')
    focusable[focusable.length - 1].focus()
    fireEvent.keyDown(focusable[focusable.length - 1], { key: 'Tab' })
    expect(document.activeElement).toBe(focusable[0])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
  })

  it('a late open for a previous session cannot overwrite the selected session model/context', async () => {
    setViewport(1280)
    seedStore(null)
    const sessionA = 'proj/a.jsonl'
    const sessionB = 'proj/b.jsonl'
    const sessions = [
      { sessionKey: sessionA, projectId: 'p1', title: 'Session A', status: 'idle' as const, updatedAt: 2 },
      { sessionKey: sessionB, projectId: 'p1', title: 'Session B', status: 'idle' as const, updatedAt: 1 },
    ]
    let resolveOpenA: (value: { result: Record<string, unknown>; current: boolean }) => void = () => {}
    const openAStarted = vi.fn()
    const snapshot = (key: string) => ({ result: { sessionKey: key, title: key, epoch: 'e1', seq: 1, kind: 'snapshot', turns: [], state: { running: false }, pendingUi: [] }, current: true })
    const raceConn = {
      ...fakeConn,
      closeSession: vi.fn(async () => ({})),
      openSessionTracked: vi.fn((key: string) => key === sessionA
        ? new Promise<{ result: Record<string, unknown>; current: boolean }>((resolve) => { openAStarted(); resolveOpenA = resolve })
        : Promise.resolve(snapshot(key))),
      request: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'project.list') return { projects: [{ id: 'p1', name: 'Project' }] }
        if (method === 'session.watchList') return { sessions }
        if (method === 'session.stats') return { context: { tokens: 1, window: 100, messages: 1, breakdown: [] }, usage: null }
        if (method === 'command.list') return { commands: [] }
        if (method === 'model.list') {
          const key = String(params.sessionKey)
          const id = key === sessionA ? 'model-a' : 'model-b'
          return { models: [{ id, name: id === 'model-a' ? 'Model A' : 'Model B', provider: 'test', group: 'custom' }], current: id, thinking: 'low', availableThinking: ['low'] }
        }
        if (method === 'session.branches') return { branches: [] }
        if (method === 'file.list') return { entries: [], truncated: false }
        return {}
      },
    } as unknown as HostConnection
    render(<Workbench connections={[{ hostId: 'h1', conn: raceConn }]} />)
    fireEvent.click(await screen.findByText('Session A'))
    await waitFor(() => expect(openAStarted).toHaveBeenCalled())
    fireEvent.click(screen.getByText('Session B'))
    await waitFor(() => expect(screen.getByRole('button', { name: /Model: Model B/ })).toBeTruthy())

    await act(async () => {
      resolveOpenA({ result: snapshot(sessionA).result, current: false })
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: /Model: Model B/ })).toBeTruthy()
  })

  it('UAT R4: first send from the new-session view applies the picked model before turn.send', async () => {
    seedStore(null)
    useWorkbench.setState({
      activeHostId: 'h1',
      slices: {
        h1: {
          state: 'online', detail: null, role: 'operator', ownerProtocol: 1,
          projects: [{ id: 'p1', name: 'Project' }], selectedProjectId: 'p1',
          sessions: [{ sessionKey: 'proj/a.jsonl', projectId: 'p1', title: 'A', status: 'idle' as const, updatedAt: 1 }],
          selectedSessionKey: null,
          timelines: {},
        },
      },
    })
    const calls: string[] = []
    const sendConn = {
      ...fakeConn,
      request: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push(method)
        if (method === 'session.watchList') return { sessions: [{ sessionKey: 'proj/a.jsonl', projectId: 'p1', title: 'A', status: 'idle', updatedAt: 1 }] }
        if (method === 'project.list') return { projects: [{ id: 'p1', name: 'Project' }] }
        if (method === 'session.create') return { sessionKey: 'proj/new.jsonl' }
        if (method === 'model.list') return { models: [{ id: 'model-x', name: 'Model X', provider: 'test', group: 'custom' }], current: null, thinking: null, availableThinking: [] }
        if (method === 'model.set') return {}
        if (method === 'turn.send') return {}
        if (method === 'session.stats') return {}
        if (method === 'command.list') return { commands: [] }
        if (method === 'session.branches') return { branches: [] }
        return {}
      },
    } as unknown as HostConnection
    render(<Workbench connections={[{ hostId: 'h1', conn: sendConn }]} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Model:/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Model:/ }))
    fireEvent.change(await screen.findByLabelText('Tìm model'), { target: { value: 'Model X' } })
    fireEvent.click(await screen.findByRole('option', { name: /Model X/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Model: Model X/ })).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Tin nhắn'), { target: { value: 'hello first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }))
    await waitFor(() => expect(calls).toContain('turn.send'))
    const createAt = calls.indexOf('session.create')
    const setAt = calls.indexOf('model.set')
    const sendAt = calls.indexOf('turn.send')
    expect(createAt).toBeGreaterThanOrEqual(0)
    expect(setAt).toBeGreaterThan(createAt)
    expect(sendAt).toBeGreaterThan(setAt)
    expect(useWorkbench.getState().slices.h1.selectedSessionKey).toBe('proj/new.jsonl')
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
