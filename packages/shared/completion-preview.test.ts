import { describe, expect, it } from 'vitest'
import {
  buildCompletionNotificationCopy,
  normalizePreviewWhitespace,
  redactCompletionPreview,
  sanitizeCompletionPreview,
  truncateGraphemes,
} from './completion-preview'

describe('completion preview sanitizer', () => {
  it('strips control characters and collapses whitespace', () => {
    expect(normalizePreviewWhitespace('hello\u0007\n\n  world\t!')).toBe('hello world !')
  })

  it('truncates by grapheme including emoji', () => {
    expect(truncateGraphemes('👨‍👩‍👧‍👦abcd', 2)).toBe('👨‍👩‍👧‍👦a…')
    expect(truncateGraphemes('你好世界', 2)).toBe('你好…')
  })

  it('redacts secrets, query tokens and absolute paths', () => {
    const text = redactCompletionPreview(
      'see C:\\Users\\admin\\.ssh\\id_rsa and https://x.test/?token=abc123 sk-abcdefghijklmnopqrstuvwxyz Bearer abc.def',
    )
    expect(text).not.toContain('id_rsa')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(text).not.toContain('Bearer abc.def')
    expect(text).toContain('[path]')
    expect(text).toContain('[redacted]')
  })

  it('does not keep thinking-like or path-heavy assistant dumps in the card body', () => {
    const body = sanitizeCompletionPreview(
      'Done.\nC:\\workspace\\pi-app\\secret.env ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      140,
    )
    expect(body).not.toContain('secret.env')
    expect(body).not.toContain('ghp_')
  })
})

describe('completion notification copy', () => {
  it('uses a fixed privacy body and never invents project data for tests', () => {
    const copy = buildCompletionNotificationCopy({
      language: 'zh',
      outcome: 'success',
      promptPreview: '真实用户任务',
      responsePreview: '真实回复',
      previewMode: 'response',
      isTest: true,
    })
    expect(copy.title).toBe('测试提醒')
    expect(copy.body).toBe('任务完成，可以返回查看')
    expect(copy.body).not.toContain('真实')
  })

  it('hides the reply when preview mode is fixed', () => {
    const copy = buildCompletionNotificationCopy({
      language: 'en',
      outcome: 'success',
      promptPreview: 'Ship the patch',
      responsePreview: 'Patched the worker idle path',
      previewMode: 'fixed',
      durationMs: 12_400,
    })
    expect(copy.title).toBe('Ship the patch')
    expect(copy.body).toBe('Task finished. You can return to the session.')
    expect(copy.meta).toContain('12s')
  })

  it('renders Vietnamese copy for test and completion notifications', () => {
    const testCopy = buildCompletionNotificationCopy({
      language: 'vi',
      outcome: 'success',
      promptPreview: 'Chạy bộ test',
      responsePreview: 'Đã vá xong luồng nền',
      previewMode: 'response',
      isTest: true,
    })
    expect(testCopy.title).toBe('Thông báo thử')
    expect(testCopy.body).toBe('Việc đã xong, có thể quay lại xem')
    expect(testCopy.openLabel).toBe('Về ứng dụng')
    expect(testCopy.muteLabel).toBe('Im 30 phút')

    const copy = buildCompletionNotificationCopy({
      language: 'vi',
      outcome: 'success',
      promptPreview: 'Ship the patch',
      responsePreview: '',
      previewMode: 'fixed',
      durationMs: 12_400,
    })
    expect(copy.title).toBe('Ship the patch')
    expect(copy.body).toBe('Việc đã xong, có thể quay lại xem')
    expect(copy.meta).toContain('Hoàn thành')
    expect(copy.meta).toContain('12 giây')
    expect(copy.openLabel).toBe('Mở phiên')
  })

  it('renders Vietnamese failure and cancelled outcomes', () => {
    const failed = buildCompletionNotificationCopy({
      language: 'vi',
      outcome: 'failed',
      previewMode: 'fixed',
    })
    expect(failed.meta).toContain('Thất bại')
    const cancelled = buildCompletionNotificationCopy({
      language: 'vi',
      outcome: 'cancelled',
      previewMode: 'fixed',
    })
    expect(cancelled.meta).toContain('Đã hủy')
  })
})
