import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const indexHtml = readFileSync(resolve(webRoot, 'index.html'), 'utf8').replace(/\r\n?/g, '\n')
const pagesHeaders = readFileSync(resolve(webRoot, 'public', '_headers'), 'utf8')
const previewHtml = readFileSync(resolve(webRoot, 'dev', 'workbench-preview.html'), 'utf8').replace(/\r\n?/g, '\n')
const viteConfig = readFileSync(resolve(webRoot, 'vite.config.ts'), 'utf8')

function getInlineThemeScriptHash(): string {
  const match = indexHtml.match(/<script>([\s\S]*?)<\/script>/)
  if (!match) throw new Error('index.html must keep the inline theme bootstrap script')
  const digest = createHash('sha256').update(match[1], 'utf8').digest('base64')
  return `'sha256-${digest}'`
}

describe('Li Web production CSP', () => {
  it('allows only the exact inline theme bootstrap and same-origin PWA manifest', () => {
    const hash = getInlineThemeScriptHash()
    const metaCsp = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]
    const headerCsp = pagesHeaders.match(/Content-Security-Policy:\s*([^\r\n]+)/)?.[1]
    const previewCsp = previewHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]
    const viteCsp = viteConfig.match(/const PROD_CSP\s*=\s*"([^"]+)"/)?.[1]

    expect(metaCsp).toBeTruthy()
    expect(headerCsp).toBeTruthy()
    expect(previewCsp).toBeTruthy()
    expect(viteCsp).toBeTruthy()
    expect(metaCsp).toBe(viteCsp)
    expect(previewCsp).toBe(viteCsp)
    expect(headerCsp).toBe(viteCsp!.replace("; base-uri 'self'; form-action 'none'", "; frame-ancestors 'none'; base-uri 'self'; form-action 'none'"))
    for (const policy of [metaCsp!, headerCsp!, previewCsp!, viteCsp!]) {
      const scriptSrc = policy.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('script-src '))
      const scriptSources = scriptSrc?.split(/\s+/) ?? []
      expect(scriptSources).toContain("'self'")
      expect(scriptSources).toContain(hash)
      expect(scriptSources).not.toContain("'unsafe-inline'")
      expect(policy).toContain("manifest-src 'self'")
    }

    // frame-ancestors only works as an HTTP header, never in a meta CSP.
    expect(metaCsp).not.toContain('frame-ancestors')
    expect(viteCsp).not.toContain('frame-ancestors')
    expect(headerCsp).toContain("frame-ancestors 'none'")
  })
})
