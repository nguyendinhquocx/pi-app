import { describe, expect, it } from 'vitest'
import { defaultAppLanguage } from './default-language'

describe('defaultAppLanguage', () => {
  it('defaults a fresh install to Vietnamese regardless of system locale', () => {
    expect(defaultAppLanguage({ LANG: 'zh_CN.UTF-8' }, 'en-US')).toBe('vi')
    expect(defaultAppLanguage({ LC_ALL: 'en_US.UTF-8' }, 'zh-CN')).toBe('vi')
    expect(defaultAppLanguage({}, 'vi-VN')).toBe('vi')
  })

  it('ignores POSIX locale variables for the fresh-install default', () => {
    expect(defaultAppLanguage({ LANG: 'de_DE.UTF-8' }, 'zh-CN')).toBe('vi')
    expect(defaultAppLanguage({ LANG: 'C.UTF-8' }, 'en-US')).toBe('vi')
    expect(defaultAppLanguage({}, 'fr-FR')).toBe('vi')
  })
})
