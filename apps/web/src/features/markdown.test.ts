// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeHtml, sanitizeExportDocument, isAllowedAsIs } from './markdown'

/**
 * Spec T4: markdown/tool-card/diff render through a strict DOMPurify profile — iframe/object/
 * script are forbidden. react-markdown drops raw HTML already; this profile guards everything
 * we intentionally render as HTML (tool previews, export documents).
 */

describe('DOMPurify strict profile (spec T4 acceptance)', () => {
  it('strips script/iframe/object/embed entirely', () => {
    expect(sanitizeHtml('<script>alert(1)</script>ok')).toBe('ok')
    expect(sanitizeHtml('<iframe src="https://evil"></iframe>text')).toBe('text')
    expect(sanitizeHtml('<object data="x"></object>a')).toBe('a')
    expect(sanitizeHtml('<embed src="x">b')).toBe('b')
    expect(sanitizeHtml('<form action="x"><input></form>c')).toBe('c')
  })

  it('strips inline event handlers and javascript: URLs', () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(1)">')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('javascript:')
    const link = sanitizeHtml('<a href="javascript:alert(1)">x</a>')
    expect(link).not.toContain('javascript:')
  })

  it('keeps allow-listed formatting intact', () => {
    const html = '<h2>Tiêu đề</h2><p>text <strong>đậm</strong> <em>nghiêng</em></p><pre><code>code()</code></pre>'
    expect(isAllowedAsIs(html)).toBe(true)
    expect(sanitizeHtml('<table><tr><td colspan="2">cell</td></tr></table>')).toContain('colspan="2"')
  })

  it('links get target=_blank + rel noopener (hook)', () => {
    const out = sanitizeHtml('<a href="https://example.com">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('noopener')
  })

  it('style/svg/math tags are forbidden (worse-than-nothing render surface)', () => {
    for (const tag of ['style', 'svg', 'math', 'base', 'meta', 'link']) {
      const out = sanitizeHtml(`<${tag}>x</${tag}>`)
      expect(out).not.toContain(`<${tag}`)
    }
  })

  it('export document wraps sanitized body with escaped title', () => {
    const doc = sanitizeExportDocument('<script>x</script> Session', '<p>body <img src=x onerror=y> ok</p>')
    expect(doc).toContain('<title>&lt;script&gt;x&lt;/script&gt; Session</title>')
    expect(doc).not.toContain('onerror')
    expect(doc).toContain('<p>body <img src="x"> ok</p>')
  })
})
