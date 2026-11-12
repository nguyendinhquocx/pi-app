import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Recursive catalog parity across en/zh/vi: same key paths, and each interpolation
 * placeholder must appear the same number of times per string (multiset, not just presence).
 *
 * Vietnamese must be complete (fork's default UI language): en↔vi is strict on keys and
 * placeholder multiplicity. The upstream Chinese catalogs carry a small, known key gap
 * (i18next falls back to English at runtime); ZH_KNOWN_KEY_GAPS locks that gap so the test
 * fails only when it grows. Placeholder multiplicity is checked for every shared key.
 */

type FlatMap = Record<string, unknown>

const locales = ['en', 'zh', 'vi'] as const
const localeDir = join(__dirname, '..', '..', 'locales')

/** Pre-existing en↔zh key drift in upstream catalogs (common/settings). Do not let it grow. */
const ZH_KNOWN_KEY_GAPS: Record<string, { missing: string[]; extra: string[] }> = {
  common: {
    // Filled during the fork's Vietnamese UI work (renderer built-in strings localization).
    missing: [],
    extra: [],
  },
  settings: {
    missing: [
      'mcp.toolCount_one',
      'mcp.toolCount_other',
      'models.modelCount_one',
      'models.modelCount_other',
      'usage.callsCount_one',
      'usage.callsCount_other',
      'usage.days_one',
      'usage.days_other',
    ],
    extra: ['mcp.toolCount', 'usage.callsCount', 'usage.days'],
  },
}

/** Pre-existing en↔zh placeholder drift on shared keys. Do not let it grow. */
const ZH_KNOWN_PLACEHOLDER_DRIFT: Record<string, Record<string, string[]>> = {
  settings: { 'models.modelCount': ['{{count}}'] },
}

function flatten(value: unknown, prefix = '', out: FlatMap = {}): FlatMap {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out)
    }
  } else {
    out[prefix] = value
  }
  return out
}

function placeholders(value: unknown): string[] {
  const text = typeof value === 'string' ? value : ''
  return text.match(/\{\{[^}]+\}\}/g) ?? []
}

function countMultiset(items: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

function loadLocale(locale: string): Map<string, FlatMap> {
  const dir = join(localeDir, locale)
  const namespaces = new Map<string, FlatMap>()
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    namespaces.set(file.replace(/\.json$/, ''), flatten(parsed))
  }
  return namespaces
}

describe('desktop locale catalog parity (en/zh/vi)', () => {
  const catalogs = new Map(locales.map((locale) => [locale, loadLocale(locale)]))
  const en = catalogs.get('en')!

  it('covers the same 12 namespaces in every locale', () => {
    for (const locale of locales) {
      expect([...catalogs.get(locale)!.keys()].sort()).toEqual([...en.keys()].sort())
    }
    expect(en.size).toBe(12)
  })

  it('keeps vi (fork default) complete against en in every namespace', () => {
    for (const namespace of [...en.keys()].sort()) {
      const enMap = en.get(namespace)!
      const viMap = catalogs.get('vi')!.get(namespace)!
      expect({
        namespace,
        missing: Object.keys(enMap).filter((key) => !(key in viMap)),
        extra: Object.keys(viMap).filter((key) => !(key in enMap)),
      }).toEqual({ namespace, missing: [], extra: [] })
    }
  })

  it('does not grow the known upstream zh key gap', () => {
    for (const namespace of [...en.keys()].sort()) {
      const enMap = en.get(namespace)!
      const zhMap = catalogs.get('zh')!.get(namespace)!
      const missing = Object.keys(enMap).filter((key) => !(key in zhMap)).sort()
      const extra = Object.keys(zhMap).filter((key) => !(key in enMap)).sort()
      const known = ZH_KNOWN_KEY_GAPS[namespace] ?? { missing: [], extra: [] }
      expect({ namespace, zhMissing: missing }).toEqual({ namespace, zhMissing: known.missing.sort() })
      expect({ namespace, zhExtra: extra }).toEqual({ namespace, zhExtra: known.extra.sort() })
    }
  })

  for (const namespace of [...en.keys()].sort()) {
    it(`matches placeholder multiplicity for shared keys in ${namespace}`, () => {
      const enMap = en.get(namespace)!
      for (const locale of locales) {
        const other = catalogs.get(locale)!.get(namespace)!
        for (const key of Object.keys(enMap)) {
          if (!(key in other)) continue
          if (
            locale === 'zh' &&
            ZH_KNOWN_PLACEHOLDER_DRIFT[namespace]?.[key]?.join(',') ===
              placeholders(other[key]).sort().join(',')
          ) {
            continue
          }
          expect({
            namespace,
            locale,
            key,
            placeholders: countMultiset(placeholders(enMap[key])),
          }).toEqual({
            namespace,
            locale,
            key,
            placeholders: countMultiset(placeholders(other[key])),
          })
        }
      }
    })
  }
})
