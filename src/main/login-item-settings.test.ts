import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const calls: Array<{ path: string; args: string[]; openAtLogin: boolean }> = []
  let entries: Map<string, boolean>
  const keyOf = (path: string, args: string[]) => `${path}|${args.join(' ')}`
  const app = {
    setLoginItemSettings(settings: { path: string; args: string[]; openAtLogin: boolean }) {
      calls.push({ path: settings.path, args: settings.args, openAtLogin: settings.openAtLogin })
      const key = keyOf(settings.path, settings.args)
      if (settings.openAtLogin) entries.set(key, true)
      else entries.delete(key)
    },
    getLoginItemSettings(options: { path: string; args: string[] }) {
      return { openAtLogin: entries.get(keyOf(options.path, options.args)) === true }
    },
  }
  return {
    app,
    calls,
    reset() {
      entries = new Map()
      calls.length = 0
    },
  }
})

vi.mock('electron', () => ({ app: electron.app }))

import {
  applyLoginItemSettings,
  HIDDEN_LAUNCH_ARG,
  isHiddenStartupLaunch,
  readLoginItemSettings,
} from './login-item-settings'

const EXEC_PATH = 'C:/apps/pi Desktop.exe'

describe('login-item-settings', () => {
  beforeEach(() => {
    electron.reset()
    vi.stubGlobal('process', { ...process, platform: 'win32', execPath: EXEC_PATH, argv: [EXEC_PATH] })
  })

  it('registers with hidden arg only when both startup and hidden are enabled', () => {
    applyLoginItemSettings(true, true)
    const last = electron.calls[electron.calls.length - 1]
    expect(last.openAtLogin).toBe(true)
    expect(last.args).toEqual([HIDDEN_LAUNCH_ARG])
    expect(last.path).toBe(EXEC_PATH)

    const state = readLoginItemSettings()
    expect(state.registered).toBe(true)
    expect(state.hidden).toBe(true)
  })

  it('registers without hidden arg when hidden is disabled', () => {
    applyLoginItemSettings(true, false)
    const last = electron.calls[electron.calls.length - 1]
    expect(last.openAtLogin).toBe(true)
    expect(last.args).toEqual([])

    const state = readLoginItemSettings()
    expect(state.registered).toBe(true)
    expect(state.hidden).toBe(false)
  })

  it('unregistering clears both argv variants so no stale entry survives a hidden switch', () => {
    applyLoginItemSettings(true, true)
    expect(readLoginItemSettings().registered).toBe(true)
    applyLoginItemSettings(false, true)
    expect(readLoginItemSettings()).toEqual({ registered: false, hidden: false })
    // clearing writes an explicit openAtLogin=false call for the --hidden variant
    const clearCalls = electron.calls.filter((c) => !c.openAtLogin)
    expect(clearCalls.some((c) => c.args.join(' ') === HIDDEN_LAUNCH_ARG)).toBe(true)
    expect(clearCalls.some((c) => c.args.length === 0)).toBe(true)
  })

  it('switching hidden while registered replaces the entry instead of duplicating it', () => {
    applyLoginItemSettings(true, false)
    expect(readLoginItemSettings().hidden).toBe(false)
    applyLoginItemSettings(true, true)
    const state = readLoginItemSettings()
    expect(state.registered).toBe(true)
    expect(state.hidden).toBe(true)
  })

  it('detects hidden startup only from the --hidden argv marker', () => {
    expect(isHiddenStartupLaunch([EXEC_PATH, HIDDEN_LAUNCH_ARG])).toBe(true)
    expect(isHiddenStartupLaunch([EXEC_PATH])).toBe(false)
    expect(isHiddenStartupLaunch([EXEC_PATH, '--other-flag'])).toBe(false)
  })

  it('reads a hidden-only registration as not registered when queried with plain args', () => {
    applyLoginItemSettings(true, true)
    const plain = electron.app.getLoginItemSettings({ path: EXEC_PATH, args: [] })
    expect(plain.openAtLogin).toBe(false)
  })
})
