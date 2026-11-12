import { app } from 'electron'

/**
 * Windows login item wrapper. Registration and lookup must always address the SAME
 * path + args pair, otherwise Windows treats them as different entries.
 * Hidden startup is expressed as a custom `--hidden` argv (not Electron's openAsHidden,
 * which is not supported on Windows), so the main process can branch on it at launch.
 */
export const HIDDEN_LAUNCH_ARG = '--hidden'

export type LoginItemState = { registered: boolean; hidden: boolean }

function itemOptions(args: string[]): { path: string; args: string[] } {
  return { path: process.execPath, args }
}

/**
 * (Re)register the login item. On Windows, entries are keyed by path+args: clear both
 * variants first so switching hidden on/off never leaves a stale entry behind.
 * Dev runs are excluded: process.execPath is electron.exe there, and registering it as a
 * login item would launch a bare Electron window at sign-in.
 */
export function applyLoginItemSettings(enabled: boolean, hidden: boolean): void {
  if (process.platform !== 'win32') return
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: false, ...itemOptions([HIDDEN_LAUNCH_ARG]) })
  app.setLoginItemSettings({ openAtLogin: false, ...itemOptions([]) })
  if (enabled) {
    app.setLoginItemSettings({
      openAtLogin: true,
      ...itemOptions(hidden ? [HIDDEN_LAUNCH_ARG] : []),
    })
  }
}

/**
 * Query both argv variants: an entry registered with `--hidden` reports openAtLogin=false
 * when looked up with empty args, and vice versa.
 */
export function readLoginItemSettings(): LoginItemState {
  if (process.platform !== 'win32') return { registered: false, hidden: false }
  const plain = app.getLoginItemSettings(itemOptions([]))
  const withHiddenArg = app.getLoginItemSettings(itemOptions([HIDDEN_LAUNCH_ARG]))
  return {
    registered: plain.openAtLogin === true || withHiddenArg.openAtLogin === true,
    hidden: withHiddenArg.openAtLogin === true,
  }
}

/** True when this launch came from the login item with the hidden marker (not a manual launch). */
export function isHiddenStartupLaunch(argv: string[] = process.argv): boolean {
  return argv.includes(HIDDEN_LAUNCH_ARG)
}
