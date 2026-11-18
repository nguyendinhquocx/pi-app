import { describe, expect, it } from 'vitest'
import type { UiRequest } from '@shared/remote'
import { resolveAdapter, fallbackRawPayload, FALLBACK_NOTICE, KNOWN_EXTENSIONS } from './adapter-registry'
import { normalizeUnknownCustomUiRequest } from '../transport/web-ui-request'
import { timelineToMarkdown, timelineToHtmlBody } from '../workbench/export-session'
import { sanitizeExportDocument } from '../features/markdown'
import type { Turn } from '@shared/remote'

/** Spec T4: unknown extension UI → fallback card data (warning treatment, collapsed raw). */

const req = (over: Record<string, unknown> & { method: UiRequest['method']; id: string }): UiRequest =>
  ({ sessionKey: 's', ...over }) as unknown as UiRequest

describe('extension adapter registry (fallback card contract)', () => {
  it('built-in kinds map to native adapters', () => {
    for (const method of ['select', 'confirm', 'input', 'editor', 'notify'] as const) {
      const a = resolveAdapter(req({ id: '1', method }))
      expect(a.native).toBe(true)
      expect(a.kind).toBe(method)
    }
  })

  it('adapter kinds with a desktop contract get native web adapters', () => {
    const ask = resolveAdapter(req({ id: '2', method: 'custom', kind: 'ask_user_question', questions: [] }) as UiRequest)
    expect(ask).toMatchObject({ kind: 'ask_user_question', native: true })
    expect(KNOWN_EXTENSIONS.ask_user_question).toBeTruthy()
    const img = resolveAdapter(req({ id: '3', method: 'custom', kind: 'image_review', image: 'data:image/png;base64,AA', title: '', question: '', options: [], allowFeedback: false }) as UiRequest)
    expect(img).toMatchObject({ kind: 'image_review', native: true })
    const localImage = resolveAdapter(req({ id: '3b', method: 'custom', kind: 'image_review', image: 'C:/host/file.png', title: '', question: '', options: [], allowFeedback: false }) as UiRequest)
    expect(localImage).toMatchObject({ kind: 'fallback', native: false })
  })

  it('ANY other custom kind falls to the fallback card with warning copy (not error red)', () => {
    const unknown = normalizeUnknownCustomUiRequest({ id: '4', sessionKey: 's', method: 'custom', kind: 'acme_super_panel', extensionName: 'Acme' })
    expect(unknown).not.toBeNull()
    const weird = resolveAdapter(unknown!)
    expect(weird).toMatchObject({ kind: 'fallback', native: false, extension: 'Acme' })
    expect(FALLBACK_NOTICE).toBe('Chưa hỗ trợ trên Web')
    // Warning treatment is enforced by the component style contract: no 'error' wording.
    expect(FALLBACK_NOTICE.toLowerCase()).not.toContain('lỗi')
    expect(FALLBACK_NOTICE.toLowerCase()).not.toContain('error')
  })

  it('fallback raw payload is JSON, bounded at the cap', () => {
    const big = normalizeUnknownCustomUiRequest({ id: '5', sessionKey: 's', method: 'custom', kind: 'x', title: 'y', payload: 'z'.repeat(5000), apiToken: 'secret' })
    expect(big).not.toBeNull()
    const raw = fallbackRawPayload(big!, 2000)
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw.length).toBeLessThanOrEqual(2100)
  })
})

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 't1',
    anchor: 'a1',
    status: 'done',
    user: { text: 'Viết unit test' },
    activity: { counts: { read: 1, edit: 2, write: 0, run: 3, search: 0, think: 0, other: 0 }, failed: 0 },
    steps: [
      { id: 's1', kind: 'thinking', text: 'plan' },
      {
        id: 's2',
        kind: 'tool',
        toolCallId: 'c1',
        toolName: 'bash',
        category: 'run',
        status: 'ok',
        node: { template: 'bash', title: 'bash', fields: {}, status: 'ok', preview: '3 passing', fallbackText: 'bash' },
      },
      { id: 's3', kind: 'prose', text: 'doing' },
    ],
    answer: 'Xong rồi.',
    files: [{ path: 'src/a.ts', add: 4, del: 1 }],
    ...overrides,
  }
}

describe('session export (spec T4: Markdown + HTML client-side; JSON excluded)', () => {
  it('markdown export contains user text, steps, answer and files', () => {
    const md = timelineToMarkdown('S1', [makeTurn()])
    expect(md).toContain('# S1')
    expect(md).toContain('Viết unit test')
    expect(md).toContain('<details><summary>Thinking</summary>')
    expect(md).toContain('`bash` (run) — ok')
    expect(md).toContain('3 passing')
    expect(md).toContain('Xong rồi.')
    expect(md).toContain('`src/a.ts` (+4/-1)')
  })

  it('html body escapes everything; sanitized doc forbids injection', () => {
    const turns = [makeTurn({ user: { text: '<img src=x onerror=alert(1)>', }, answer: '<script>bad()</script>' })]
    const body = timelineToHtmlBody(turns)
    // Escaped as TEXT — the markup never renders as an element.
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(body).not.toContain('<img src=x')
    const doc = sanitizeExportDocument('T', body)
    expect(doc).not.toContain('<script>')
    expect(doc).not.toContain('<img src=x')
  })
})
