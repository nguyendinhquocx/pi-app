import { app, Menu, Tray } from 'electron'
import { resolveAppIcon } from './app-icon'
import { configStore } from './config-store'
import { getMainWindow } from './window'

let appTray: Tray | null = null

export function focusMainWindow(): void {
  const window = getMainWindow()
  if (!window) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

function trayCopy(language: 'zh' | 'en' | 'vi') {
  return {
    hide: language === 'vi' ? 'Ẩn cửa sổ' : language === 'en' ? 'Hide Window' : '隐藏窗口',
    show: language === 'vi' ? 'Hiện cửa sổ' : language === 'en' ? 'Show Window' : '显示窗口',
    quit: language === 'vi' ? 'Thoát' : language === 'en' ? 'Quit' : '退出',
  }
}

function openTrayMenu(): void {
  const window = getMainWindow()
  const visible = window?.isVisible() ?? false
  const copy = trayCopy(configStore.get('language'))
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: visible ? copy.hide : copy.show,
      click: visible ? () => getMainWindow()?.hide() : focusMainWindow,
    },
    { type: 'separator' },
    { label: copy.quit, click: () => app.quit() },
  ]
  Menu.buildFromTemplate(template).popup()
}

export function ensureAppTray(platform = process.platform): Tray | null {
  if (platform !== 'win32') return null
  if (appTray) return appTray

  const icon = resolveAppIcon()
  if (!icon) {
    console.warn('[Tray] App icon is unavailable')
    return null
  }

  appTray = new Tray(icon)
  appTray.setToolTip('pi Desktop')
  appTray.on('click', focusMainWindow)
  appTray.on('right-click', openTrayMenu)
  return appTray
}

export function destroyAppTray(): void {
  appTray?.destroy()
  appTray = null
}
