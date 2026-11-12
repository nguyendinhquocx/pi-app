import { configStore } from './config-store'

export type UiLanguage = 'zh' | 'en' | 'vi'

/** Saved UI language, resolving any legacy/unknown value to the fork default (vi). */
export function uiLanguage(): UiLanguage {
  const saved = configStore.get('language')
  return saved === 'en' || saved === 'zh' ? saved : 'vi'
}

/** Pick a user-facing copy variant by UI language. */
export function uiText(copy: { vi: string; en: string; zh: string }): string {
  return copy[uiLanguage()]
}
