import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  class FakeWebContents {
    on = vi.fn()
    once = vi.fn()
    setWindowOpenHandler = vi.fn()
    reload = vi.fn()
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    webContents = new FakeWebContents()
    listeners = new Map<string, Array<() => void>>()
    show = vi.fn()
    showInactive = vi.fn()
    hide = vi.fn()
    isDestroyed = vi.fn(() => false)
    loadFile = vi.fn()
    loadURL = vi.fn()

    constructor() {
      FakeBrowserWindow.instances.push(this)
    }

    on(event: string, cb: () => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb])
    }
  }

  return { FakeBrowserWindow, shellOpenExternal: vi.fn() }
})

vi.mock('electron', () => ({
  BrowserWindow: electron.FakeBrowserWindow,
  shell: { openExternal: electron.shellOpenExternal },
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./config-store', () => ({
  configStore: { get: vi.fn(() => null), set: vi.fn() },
}))
vi.mock('./custom-theme-startup', () => ({ customThemeRendererArgument: () => '--pi-theme-arg' }))
vi.mock('./worker-manager', () => ({ workerManager: { stop: vi.fn(), setMainWindow: vi.fn() } }))
vi.mock('./window-close-guard', () => ({
  installWindowCloseGuard: vi.fn(),
  guardAppQuit: vi.fn(() => true),
}))
vi.mock('./app-icon', () => ({ resolveAppIcon: vi.fn(() => null) }))

import { createWindow, getMainWindow } from './window'

const readyToShow = (): InstanceType<typeof electron.FakeBrowserWindow> =>
  electron.FakeBrowserWindow.instances.at(-1)!

describe('window hidden startup launch', () => {
  beforeEach(() => {
    electron.FakeBrowserWindow.instances.length = 0
    delete process.env.PI_E2E
  })

  it('keeps the window hidden on a --hidden login launch (no ready-to-show flash)', () => {
    const win = createWindow(false, true)
    expect(win).toBeDefined()
    expect(getMainWindow()).not.toBeNull()

    for (const cb of readyToShow().listeners.get('ready-to-show') ?? []) cb()
    expect(readyToShow().show).not.toHaveBeenCalled()
    expect(readyToShow().showInactive).not.toHaveBeenCalled()
  })

  it('shows the window on a normal launch even when the hidden preference is on', () => {
    createWindow(false, false)
    for (const cb of readyToShow().listeners.get('ready-to-show') ?? []) cb()
    expect(readyToShow().show).toHaveBeenCalledOnce()
    expect(readyToShow().showInactive).not.toHaveBeenCalled()
  })

  it('still shows immediately in e2e mode regardless of hidden launch', () => {
    process.env.PI_E2E = '1'
    createWindow(false, true)
    for (const cb of readyToShow().listeners.get('ready-to-show') ?? []) cb()
    expect(readyToShow().show).toHaveBeenCalledOnce()
  })
})
