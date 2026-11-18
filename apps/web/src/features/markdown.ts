import DOMPurify, { type Config } from 'dompurify'

/**
 * Strict sanitization profile for the workbench (spec T4): markdown/tool-card/diff renders go
 * through this profile — iframes/objects/scripts/foreign objects never survive. Markdown text
 * itself renders through react-markdown WITHOUT rehype-raw, so raw HTML in assistant text is
 * dropped entirely (belt) and this profile sanitizes anything we must render as HTML (braces:
 * tool previews, export documents).
 */

export const STRICT_PROFILE: Config = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a', 'strong', 'em', 'del', 's', 'span', 'div',
    'img', 'sup', 'sub', 'kbd',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'colspan', 'rowspan', 'align'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['iframe', 'object', 'embed', 'script', 'form', 'base', 'meta', 'link', 'style', 'svg', 'math'],
  FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur', 'srcset', 'sandbox', 'allow'],
}

let hooksInstalled = false

function installHooks(): void {
  if (hooksInstalled || typeof window === 'undefined') return
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // Links open externally and never leak the app origin as referrer.
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  })
  hooksInstalled = true
}

/** Sanitize an untrusted HTML fragment (tool previews, adapter payloads). */
export function sanitizeHtml(html: string): string {
  installHooks()
  return DOMPurify.sanitize(html, STRICT_PROFILE) as unknown as string
}

/** Sanitize + wrap into a standalone export document (session export). */
export function sanitizeExportDocument(title: string, bodyHtml: string): string {
  installHooks()
  const body = DOMPurify.sanitize(bodyHtml, STRICT_PROFILE) as unknown as string
  const safeTitle = title.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"><title>${safeTitle}</title></head><body>${body}</body></html>`
}

/** True when the string survives sanitization unchanged (used by tests for allow-listed content). */
export function isAllowedAsIs(html: string): boolean {
  return sanitizeHtml(html) === html
}
