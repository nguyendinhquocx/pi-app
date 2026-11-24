import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'apps/web/src/styles.css'), 'utf8')
const lightBlock = css.match(/:root\s*\{([^}]+)\}/)?.[1] ?? ''
const darkBlock = css.match(/\.dark\s*\{([^}]+)\}/)?.[1] ?? ''

function token(block: string, name: string): string {
  const definition = block.match(new RegExp(`--${name}:\\s*([^;]+)`))?.[1]?.trim()
  if (!definition) throw new Error(`Missing CSS color token --${name}`)
  const reference = definition.match(/^var\(--([\w-]+)\)$/)
  if (reference) return token(block, reference[1])
  if (!/^#[0-9a-fA-F]{6}$/.test(definition)) throw new Error(`Unsupported color token --${name}: ${definition}`)
  return definition
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

function expectContrastAtLeast(block: string, foregroundName: string, backgroundNames: string[], minimum: number): void {
  const foreground = token(block, foregroundName)
  for (const backgroundName of backgroundNames) {
    const ratio = contrast(foreground, token(block, backgroundName))
    expect(ratio, `--${foregroundName} on --${backgroundName}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum)
  }
}

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? ''
}

describe('Workbench text and status contrast', () => {
  it('keeps status markers distinct from light workbench surfaces', () => {
    const surfaces = ['bg-base', 'bg-1', 'bg-2', 'brand-light', 'bg-active']
    for (const status of ['status-live', 'status-warn', 'status-error']) expectContrastAtLeast(lightBlock, status, surfaces, 3)
  })

  it('keeps status markers distinct from dark workbench surfaces', () => {
    const surfaces = ['bg-base', 'bg-1', 'bg-2', 'bg-hover', 'bg-active']
    for (const status of ['status-live', 'status-warn', 'status-error']) expectContrastAtLeast(darkBlock, status, surfaces, 3)
  })

  it('keeps regular secondary text readable on the surfaces where it appears', () => {
    const lightSurfaces = ['bg-base', 'bg-1', 'bg-2', 'brand-light', 'bg-active']
    const darkSurfaces = ['bg-base', 'bg-1', 'bg-2', 'bg-hover']
    expectContrastAtLeast(lightBlock, 'text-secondary', lightSurfaces, 4.5)
    expectContrastAtLeast(darkBlock, 'text-secondary', darkSurfaces, 4.5)
    expectContrastAtLeast(lightBlock, 'diff-added', ['bg-base', 'bg-1'], 4.5)
    expectContrastAtLeast(lightBlock, 'diff-removed', ['bg-base', 'bg-1'], 4.5)
    expectContrastAtLeast(darkBlock, 'diff-added', ['bg-base', 'bg-1'], 4.5)
    expectContrastAtLeast(darkBlock, 'diff-removed', ['bg-base', 'bg-1'], 4.5)
  })

  it('uses neutral readable copy for status labels; semantic hues stay on markers/actions', () => {
    const selectors = [
      '.running-badge', '.tool-status.error', '.turn-error',
      '.turn.aborted .turn-error', '.stream-indicator', '.older-state.error', '.composer-context-cue',
      '.fallback-notice',
    ]
    for (const selector of selectors) {
      expect(ruleBody(selector), `${selector} should use secondary text`).toContain('color: var(--text-secondary)')
    }
    expect(css.match(/\.notice\.error,\s*\.notice\.success\s*\{([^}]+)\}/)?.[1] ?? '').toContain('color: var(--text-secondary)')
    expect(css.match(/\.agent-state\.running,\s*\.agent-state\.failed\s*\{([^}]+)\}/)?.[1] ?? '').toContain('color: var(--text-secondary)')
  })
})
