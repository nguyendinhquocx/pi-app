import { beforeEach, describe, expect, it, vi } from 'vitest'

const configState = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
const loginItem = vi.hoisted(() => ({
  apply: vi.fn(),
  read: vi.fn(() => ({ registered: false, hidden: false })),
}))

vi.mock('../../config-store', () => ({
  configStore: {
    get: vi.fn((key: string) => configState.store.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      configState.store.set(key, value)
    }),
    getAll: vi.fn(() => Object.fromEntries(configState.store)),
  },
}))

vi.mock('../../login-item-settings', () => ({
  applyLoginItemSettings: loginItem.apply,
  readLoginItemSettings: loginItem.read,
}))

vi.mock('../../asr-config-store', () => ({
  asrConfigForSettingsResponse: vi.fn((x) => x),
  loadAsrConfig: vi.fn(),
  saveAsrConfig: vi.fn(),
}))

vi.mock('../../window', () => ({ getMainWindow: vi.fn(() => null) }))
vi.mock('../../../extension-compat/adapter-loader', () => ({ invalidateAdapterCatalog: vi.fn() }))
vi.mock('../../worker-manager', () => ({ workerManager: { hasActiveTurns: false, stop: vi.fn() } }))
vi.mock('../../session-preview-process', () => ({ sessionPreviewProcess: { stop: vi.fn() } }))
vi.mock('../../remote/tap', () => ({ remoteTap: { settingsChanged: vi.fn() } }))

const handlers = vi.hoisted(() => new Map<string, (req: unknown) => Promise<unknown>>())
vi.mock('../registry', () => ({
  registerHandler: vi.fn((name: string, fn: (req: unknown) => Promise<unknown>) => {
    handlers.set(name, fn)
  }),
  registerHandlerWithSchema: vi.fn(
    (_name: string, _schema: unknown, fn: (req: unknown) => Promise<unknown>) => {
      handlers.set('ipc:settings.set', fn)
    },
  ),
  sendEvent: vi.fn(),
}))

import { registerSettingsHandlers } from './settings'

describe('windows startup settings handlers', () => {
  beforeEach(() => {
    handlers.clear()
    configState.store.clear()
    loginItem.apply.mockClear()
    loginItem.apply.mockReset()
    registerSettingsHandlers()
  })

  it('registers the login item when startOnLogin turns on', async () => {
    await handlers.get('ipc:settings.set')!({ key: 'startOnLogin', value: true })
    expect(configState.store.get('startOnLogin')).toBe(true)
    expect(loginItem.apply).toHaveBeenCalledWith(true, configState.store.get('startHiddenInTray'))
  })

  it('rolls the persisted key back to its exact previous value when the native API throws', async () => {
    configState.store.set('startOnLogin', true)
    configState.store.set('startHiddenInTray', true)
    loginItem.apply.mockImplementation(() => {
      throw new Error('registry denied')
    })

    // A repeated same-value save (true while already true) must roll back to true, not !value.
    await expect(
      handlers.get('ipc:settings.set')!({ key: 'startOnLogin', value: true }),
    ).rejects.toThrow('registry denied')
    expect(configState.store.get('startOnLogin')).toBe(true)
  })

  it('rolls a flipped value back to the stored value, not the negation', async () => {
    configState.store.set('startOnLogin', true)
    loginItem.apply.mockImplementation(() => {
      throw new Error('registry denied')
    })

    await expect(
      handlers.get('ipc:settings.set')!({ key: 'startOnLogin', value: false }),
    ).rejects.toThrow('registry denied')
    expect(configState.store.get('startOnLogin')).toBe(true)
  })

  it('re-registers with the new hidden flag when hidden changes while startup is on', async () => {
    configState.store.set('startOnLogin', true)
    await handlers.get('ipc:settings.set')!({ key: 'startHiddenInTray', value: false })
    expect(loginItem.apply).toHaveBeenCalledWith(true, false)
    expect(configState.store.get('startHiddenInTray')).toBe(false)
  })

  it('does not touch the login item when hidden changes while startup is off', async () => {
    configState.store.set('startOnLogin', false)
    await handlers.get('ipc:settings.set')!({ key: 'startHiddenInTray', value: true })
    expect(loginItem.apply).not.toHaveBeenCalled()
    expect(configState.store.get('startHiddenInTray')).toBe(true)
  })

  it('exposes the login item state for the settings page', async () => {
    loginItem.read.mockReturnValue({ registered: true, hidden: true })
    const res = (await handlers.get('ipc:app.getLoginItemState')!({})) as { state: unknown }
    expect(res.state).toEqual({ registered: true, hidden: true })
  })
})
