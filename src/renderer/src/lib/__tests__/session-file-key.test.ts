import { describe, expect, it } from 'vitest'
import { normalizeSessionFileKey, sessionFilesEqual } from '../session-file-key'

describe('session-file-key', () => {
  it('normalizes windows drive and separators', () => {
    expect(normalizeSessionFileKey('c:\\tmp\\a.jsonl')).toBe('C:/tmp/a.jsonl')
    expect(normalizeSessionFileKey('C:/tmp/a.jsonl')).toBe('C:/tmp/a.jsonl')
    expect(sessionFilesEqual('c:\\tmp\\a.jsonl', 'C:/tmp/a.jsonl')).toBe(true)
  })

  it('collapses duplicate slashes', () => {
    expect(normalizeSessionFileKey('/tmp//a//b.jsonl')).toBe('/tmp/a/b.jsonl')
  })

  it('preserves UNC prefix and mirrors drive/UNC canonicalization', () => {
    expect(normalizeSessionFileKey('\\\\server\\share\\s.jsonl')).toBe('//server/share/s.jsonl')
    expect(normalizeSessionFileKey('//server//share')).toBe('//server/share')
    expect(normalizeSessionFileKey('////server//share//')).toBe('///server/share/')
    expect(normalizeSessionFileKey('//')).toBe('//')
    expect(normalizeSessionFileKey('\\\\')).toBe('//')
    expect(normalizeSessionFileKey('/Home//Quoc/Session.JSONL')).toBe('/Home/Quoc/Session.JSONL')
  })
})
