import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n, { hydrateLanguageFromSettings } from '../i18n'
import { ipcClient } from '../ipc-client'

describe('startup language hydration', () => {
  const initialLanguage = i18n.resolvedLanguage || i18n.language

  afterEach(async () => {
    vi.restoreAllMocks()
    await i18n.changeLanguage(initialLanguage)
  })

  it('starts Vietnamese on a fresh install before any saved preference exists', () => {
    // The initial i18n locale is applied before IPC hydration so the first frame is already vi.
    expect(i18n.resolvedLanguage).toBe('vi')
    expect(document.documentElement.lang).toBe('vi')
  })

  it('should_use_saved_chinese_when_current_language_is_english', async () => {
    await i18n.changeLanguage('en')
    const invokeMock = vi.spyOn(ipcClient, 'invoke').mockResolvedValue({
      settings: { language: 'zh' },
    })

    const resolvedLanguage = await hydrateLanguageFromSettings()

    expect(invokeMock).toHaveBeenCalledWith('settings.get', { key: 'language' })
    expect(resolvedLanguage).toBe('zh')
    expect(i18n.resolvedLanguage).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('should_use_saved_english_when_current_language_is_chinese', async () => {
    await i18n.changeLanguage('zh')
    const invokeMock = vi.spyOn(ipcClient, 'invoke').mockResolvedValue({
      settings: { language: 'en' },
    })

    const resolvedLanguage = await hydrateLanguageFromSettings()

    expect(invokeMock).toHaveBeenCalledWith('settings.get', { key: 'language' })
    expect(resolvedLanguage).toBe('en')
    expect(i18n.resolvedLanguage).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('should_keep_a_saved_vietnamese_choice', async () => {
    await i18n.changeLanguage('en')
    const invokeMock = vi.spyOn(ipcClient, 'invoke').mockResolvedValue({
      settings: { language: 'vi' },
    })

    const resolvedLanguage = await hydrateLanguageFromSettings()

    expect(invokeMock).toHaveBeenCalledWith('settings.get', { key: 'language' })
    expect(resolvedLanguage).toBe('vi')
    expect(i18n.resolvedLanguage).toBe('vi')
    expect(document.documentElement.lang).toBe('vi')
  })

  it('should_fall_back_without_blocking_when_settings_read_fails', async () => {
    const originalLanguage = i18n.resolvedLanguage
    vi.spyOn(ipcClient, 'invoke').mockRejectedValue(new Error('settings unavailable'))

    await expect(hydrateLanguageFromSettings()).resolves.toMatch(/^(zh|en|vi)$/)
    expect(i18n.resolvedLanguage).toBe(originalLanguage)
  })
})
