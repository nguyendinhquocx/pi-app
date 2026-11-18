import { readdirSync, statSync } from 'node:fs'
import { dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PARITY_MATRIX, browserReadyRows, excludedRows, validateMatrix } from './parity-matrix'

/** Finite release gate frozen against the 46-row T0 capability inventory. */
const T0_ROWS = Array.from({ length: 46 }, (_, index) => String(index + 1))
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function findTests(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = resolve(directory, entry)
    if (statSync(full).isDirectory()) return findTests(full)
    return /\.test\.(ts|tsx)$/.test(entry) ? [relative(SOURCE_ROOT, full).split(sep).join('/')] : []
  })
}
const existingTests = findTests(SOURCE_ROOT)

describe('parity matrix (spec T4: finite T0-based full-parity gate)', () => {
  it('every ready row has a real test file and every exclusion explains why', () => {
    expect(validateMatrix(existingTests)).toEqual([])
  })

  it('every T0 capability row is accounted for (ready or excluded, never dropped)', () => {
    const covered = new Set(PARITY_MATRIX.flatMap((row) => [...row.t0.matchAll(/\d+/g)].map((match) => match[0])))
    for (const row of T0_ROWS) expect(covered.has(row), `T0 row ${row} missing from parity matrix`).toBe(true)
  })

  it('parity-required explicit cases are visible: export, theme, fork/rewind, Agents', () => {
    const find = (part: string) => PARITY_MATRIX.find((row) => row.feature.includes(part))
    expect(find('Message actions: rewind and fork')?.status).toBe('browser-ready')
    expect(find('Session export Markdown/HTML')?.status).toBe('browser-ready')
    expect(find('Session export raw JSON')).toMatchObject({ status: 'excluded', reason: expect.any(String) })
    expect(find('Appearance/theme editor')).toMatchObject({ status: 'excluded', reason: expect.any(String) })
    expect(find('Agents view')?.status).toBe('browser-ready')
    expect(find('Deep navigation into child-session')?.status).toBe('excluded')
  })

  it('unknown extension UI has a real fallback-card test row', () => {
    expect(PARITY_MATRIX.find((row) => row.feature.includes('Unknown extension UI fallback card'))).toMatchObject({
      status: 'browser-ready',
      test: 'extensions/ExtensionDialogs.test.tsx',
    })
  })

  it('excluded rows declare no remote calls', () => {
    for (const row of excludedRows()) expect(row.methods, row.feature).toHaveLength(0)
  })

  it('coverage is finite (not an open-ended promise)', () => {
    expect(browserReadyRows().length).toBeGreaterThan(25)
    expect(excludedRows().length).toBeGreaterThan(15)
    expect(PARITY_MATRIX.length).toBeLessThan(70)
  })
})
