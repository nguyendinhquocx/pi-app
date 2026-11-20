// Audit gate: verify every bare import across the linked fork SDK dist trees can
// resolve against the packaged (flat, app-root node_modules) layout BEFORE electron
// packaging runs. This exists because the 2026-11-20 host-2 deploy crashed at boot:
// the SDK dist imports chalk et al. through the monorepo symlink on laptop, but
// electron-builder could not resolve those deps through the pnpm-symlink layout and
// silently excluded them from app.asar (ERR_MODULE_NOT_FOUND: chalk at runtime).
//
// What it checks, per @earendil-works fork package (coding-agent, ai, agent-core,
// pi-schema, tui, mcp, codemode, telemetry):
//   1. Every static bare import in dist/**/*.js|cjs|mjs resolves to a package that
//      exists in pi-app/node_modules (the layout electron-builder packs).
//   2. The installed version satisfies the range the fork package declares.
//   3. Subpath imports resolve through package exports/main to an existing file.
//   4. With PI_MONO_LI_LINK_MODE=copy (packaging mode), fork packages must be REAL
//      directories (symlinks make electron-builder dependency resolution fail).
//
// Exit 0 = safe to package. Exit 1 = listing printed, packaging must not proceed.

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(join(repoRoot, 'package.json'))
const linkMode = process.env.PI_MONO_LI_LINK_MODE === 'copy' ? 'copy' : 'symlink'
const envRoot = process.env.PI_MONO_LI_ROOT
const monoLiRoot = envRoot
  ? resolve(envRoot)
  : resolve(repoRoot, '..', '..', '..', 'pi-mono-li')

// package dir in monoli → published package name (mirrors scripts/link-local-sdk.mjs)
const FORK_PACKAGES = [
  ['packages/coding-agent', '@earendil-works/pi-coding-agent'],
  ['packages/ai', '@earendil-works/pi-ai'],
  ['packages/agent', '@earendil-works/pi-agent-core'],
  ['packages/schema', '@earendil-works/pi-schema'],
  ['packages/tui', '@earendil-works/pi-tui'],
  ['packages/mcp', '@earendil-works/pi-mcp'],
  ['packages/codemode', '@earendil-works/pi-codemode'],
  ['packages/telemetry', '@earendil-works/pi-telemetry'],
]

const failures = []
const checkedImports = new Set()

function requireRangeMap() {
  const ranges = new Map()
  for (const [dir, name] of FORK_PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(monoLiRoot, dir, 'package.json'), 'utf8'))
    ranges.set(name, manifest.version)
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!ranges.has(`range:${dep}`)) ranges.set(`range:${dep}`, spec)
      else if (ranges.get(`range:${dep}`) !== spec) {
        // Conflicting ranges across fork packages: keep the strictest by failing later
        // if the installed version does not satisfy both.
        ranges.set(`range:${dep}`, `${ranges.get(`range:${dep}`)} ||| ${spec}`)
      }
    }
  }
  return ranges
}

function walkDistFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        // bundle/ trees are bundler artifacts: their bare imports resolve at bundle
        // time and are inlined, never at runtime — scripts/smoke-packaged-asar.mjs
        // proves the bundle entry loads from the packaged layout instead.
        if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'tests' || entry.name === 'bundle') continue
        stack.push(full)
      } else if (/\.(js|cjs|mjs)$/.test(entry.name) && !/\.(d\.ts|map)$/.test(entry.name)) {
        out.push(full)
      }
    }
  }
  return out
}

function collectBareImports(file) {
  const rawLines = readFileSync(file, 'utf8').split('\n')
  // Strip whole-line comments and block-comment regions so prose like
  // `// e.g. "opus" ... from "openrouter"` in dist files is not treated as an import.
  const textLines = []
  let inBlockComment = false
  for (const line of rawLines) {
    const trimmed = line.trim()
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('//')) continue
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true
      continue
    }
    textLines.push(line)
  }
  const text = textLines.join('\n')
  const found = []
  const re = /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g
  let match
  while ((match = re.exec(text)) !== null) {
    const spec = match[1]
    // A real static import specifier is a valid package name (optionally with a
    // subpath). Anything with spaces/braces is prose captured from template strings.
    if (/[^\x21-\x7e]/.test(spec) || /[\s{}()"']/.test(spec) || spec.length > 214) continue
    found.push(spec)
  }
  return found
}

function resolveWithinPackage(pkgDir, subpath) {
  // Resolves `subpath` (e.g. "lib/core" or "") inside an installed package dir using
  // exports when available, falling back to file probing.
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) return { ok: false, reason: 'package.json missing' }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (subpath === '') return { ok: true }
  const exports = manifest.exports
  if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
    const key = `./${subpath}`
    if (key in exports) {
      const target = typeof exports[key] === 'string' ? exports[key] : exports[key]?.import ?? exports[key]?.default
      if (typeof target === 'string') {
        const resolved = join(pkgDir, target.replace(/^\.\//, ''))
        if (existsSync(resolved)) return { ok: true }
        return { ok: false, reason: `exports target missing: ${target}` }
      }
    }
    // Wildcard exports ("./providers/*": "./dist/providers/*.js"): substitute the
    // matched suffix into the target and verify the substituted file exists.
    for (const [pattern, target] of Object.entries(exports)) {
      if (!pattern.includes('*')) continue
      const patternBase = pattern.slice(0, pattern.indexOf('*'))
      if (!key.startsWith(patternBase)) continue
      const suffix = key.slice(patternBase.length)
      if (suffix.includes('/')) continue // keep single-segment wildcards strict
      const targetStr = typeof target === 'string' ? target : target?.import ?? target?.default
      if (typeof targetStr !== 'string') continue
      const targetBase = targetStr.slice(0, targetStr.indexOf('*'))
      const targetExt = targetStr.slice(targetStr.indexOf('*') + 1)
      if (targetStr.includes('*') && existsSync(join(pkgDir, targetBase.replace(/^\.\//, '') + suffix + targetExt))) {
        return { ok: true }
      }
    }
  }
  const probe = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs', '/index.mjs']
  for (const ext of probe) {
    if (existsSync(join(pkgDir, subpath + ext))) return { ok: true }
  }
  return { ok: false, reason: 'subpath does not resolve (no matching exports/file)' }
}

function isRealDir(path) {
  try {
    return statSync(path).isDirectory() && !statSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function main() {
  if (!existsSync(join(monoLiRoot, 'packages/coding-agent/package.json'))) {
    console.error(`[audit] PI_MONO_LI_ROOT invalid: ${monoLiRoot}`)
    process.exit(1)
  }
  const ranges = requireRangeMap()
  const nodeModules = join(repoRoot, 'node_modules')

  // 0) Fork packages themselves: in copy mode they must be real dirs.
  for (const [, name] of FORK_PACKAGES) {
    const installed = join(nodeModules, name)
    if (!existsSync(installed)) {
      failures.push(`${name}: NOT PRESENT in node_modules (link/materialize step did not run?)`)
      continue
    }
    if (linkMode === 'copy' && !isRealDir(installed)) {
      failures.push(`${name}: still a symlink in packaging mode; run link-local-sdk with PI_MONO_LI_LINK_MODE=copy`)
    }
    const installedVersion = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version
    const expected = ranges.get(name)
    if (expected !== installedVersion) {
      failures.push(`${name}: version ${installedVersion} != fork ${expected}`)
    }
  }

  // 1) Walk every fork dist tree and resolve each bare import against the flat tree.
  for (const [dir, name] of FORK_PACKAGES) {
    const distRoot = join(monoLiRoot, dir, 'dist')
    if (!existsSync(distRoot)) {
      failures.push(`${name}: dist missing at ${distRoot} (build the fork first)`)
      continue
    }
    for (const file of walkDistFiles(distRoot)) {
      for (const spec of collectBareImports(file)) {
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) continue // URL/data schemes inside dynamic-import strings
        const builtinBase = spec.split('/')[0]
        if (builtinModules.includes(builtinBase) || builtinModules.includes(spec)) continue
        const key = `${name}::${spec}`
        if (checkedImports.has(key)) continue
        checkedImports.add(key)
        const isScoped = spec.startsWith('@')
        const pkgName = isScoped ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (pkgName === name) continue // self-reference: resolves inside the packaged package
        const pkgDir = join(nodeModules, pkgName)
        if (!existsSync(pkgDir)) {
          failures.push(`${pkgName}: MISSING from node_modules — required by ${name} (${spec})`)
          continue
        }
        if (linkMode === 'copy' && !isRealDir(pkgDir)) {
          failures.push(`${pkgName}: symlink in packaging mode — required by ${name} (${spec})`)
        }
        const subpath = isScoped ? spec.split('/').slice(2).join('/') : spec.split('/').slice(1).join('/')
        const res = resolveWithinPackage(pkgDir, subpath)
        if (!res.ok) {
          failures.push(`${spec}: unresolvable in ${pkgName} — ${res.reason} (required by ${name})`)
          continue
        }
        const range = ranges.get(`range:${pkgName}`)
        if (range) {
          let installedVersion
          try {
            installedVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version
          } catch {
            failures.push(`${pkgName}: installed package.json unreadable`)
            continue
          }
          const specs = range.split('|||').map((s) => s.trim())
          let semverModule
          try {
            semverModule = requireFromApp('semver')
          } catch {
            semverModule = null
          }
          if (semverModule) {
            for (const single of specs) {
              if (!semverModule.satisfies(installedVersion, single)) {
                failures.push(`${pkgName}: installed ${installedVersion} does not satisfy fork range "${single}" (required by ${name})`)
              }
            }
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error(`[audit] FAILED — ${failures.length} unresolvable/mismatched modules (mode=${linkMode}):`)
    for (const line of failures) console.error(`  - ${line}`)
    process.exit(1)
  }
  console.log(`[audit] PASS — ${checkedImports.size} unique bare imports resolved across ${FORK_PACKAGES.length} fork packages (mode=${linkMode})`)
}

main()
