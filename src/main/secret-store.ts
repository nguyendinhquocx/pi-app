import { safeStorage, BrowserWindow } from 'electron'
import { uiText } from './ui-language'

const STORE_KEY = 'codexAccessTokenEnc'

let backing: { get: (k: string) => unknown; set: (k: string, v: unknown) => void; delete?: (k: string) => void } | null =
  null

export function bindSecretStoreBacking(store: {
  get: (k: string) => unknown
  set: (k: string, v: unknown) => void
  delete?: (k: string) => void
}): void {
  backing = store
}

export function isCodexTokenEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch (e) {
    return false
  }
}

export function setCodexAccessToken(token: string | null | undefined): void {
  if (!backing) return
  const t = token?.trim()
  if (!t || t.length < 20) {
    if (backing.delete) backing.delete(STORE_KEY)
    else backing.set(STORE_KEY, undefined)
    return
  }
  if (!isCodexTokenEncryptionAvailable()) {
    console.warn('[secret-store] safeStorage unavailable; codex token not persisted')
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('ipc:events', {
        type: 'warning',
        message: uiText({
          vi: 'Mã hóa hệ thống không khả dụng nên Codex Token chưa được lưu. Sau khi khởi động lại bạn cần nhập lại.',
          en: 'System encryption is unavailable, so the Codex token was not persisted. You will need to re-enter it after restarting.',
          zh: '系统加密不可用，Codex Token 未持久化。重启后需重新输入。',
        }),
      })
    }
    return
  }
  const enc = safeStorage.encryptString(t)
  backing.set(STORE_KEY, enc.toString('base64'))
}

export function getCodexAccessToken(): string | null {
  if (!backing) return null
  const raw = backing.get(STORE_KEY)
  if (raw == null || raw === '') return null
  if (!isCodexTokenEncryptionAvailable()) return null
  try {
    const buf = Buffer.from(String(raw), 'base64')
    const plain = safeStorage.decryptString(buf)
    return plain && plain.length >= 20 ? plain : null
  } catch (e) {
    return null
  }
}