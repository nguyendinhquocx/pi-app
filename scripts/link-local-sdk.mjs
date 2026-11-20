// Link the pi-mono-li workspace packages this SDK fork needs into node_modules.
//
// The coding-agent fork is a regular file: dependency (npm install --install-links keeps a
// real copy for packaging), but its sibling packages (@earendil-works/pi-ai, pi-agent-core,
// pi-tui, pi-mcp, pi-codemode, pi-telemetry) resolve through node_modules symlinks created
// here. Registry copies cannot be used: upstream 1.3.0 lacks fork symbols the SDK dist
// requires (e.g. getLatestToolSelectionSnapshot). Node's ESM resolver realpaths through
// symlinks, so Electron/runtime imports work; vitest inlines these packages via
// server.deps.inline (see vitest.config.ts).
//
// Idempotent: re-run any time pi-mono-li moves or a package list changes.
// PI_MONO_LI_ROOT overrides the source tree (used on non-laptop hosts).

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scopeDir = join(repoRoot, 'node_modules', '@earendil-works')

const envRoot = process.env.PI_MONO_LI_ROOT
const monoLiRoot = envRoot
  ? resolve(envRoot)
  : resolve(repoRoot, '..', '..', '..', 'pi-mono-li')

// package dir name → @earendil-works package name. pi-coding-agent itself is REPLACED when
// npm installed a registry copy: the fork dist is the only supported runtime for the Li Web
// owner protocol, and the siblings it imports must match the fork's API surface.
const LINKS = [
  ['packages/coding-agent', 'pi-coding-agent'],
  ['packages/ai', 'pi-ai'],
  ['packages/agent', 'pi-agent-core'],
  ['packages/schema', 'pi-schema'],
  ['packages/tui', 'pi-tui'],
  ['packages/mcp', 'pi-mcp'],
  ['packages/codemode', 'pi-codemode'],
  ['packages/telemetry', 'pi-telemetry'],
]

// Packaging mode: electron-builder cannot resolve versions through symlinks into the
// pnpm-workspace tree, so it silently drops fork packages and their deps from app.asar
// (host-2 0.7.14 r2 incident, 2026-11-20). In copy mode every fork package is
// materialized as a REAL directory (node_modules excluded — deps come from the flat
// app tree). Dev mode (default) keeps symlinks so laptop runtime always sees the fork.

if (!existsSync(monoLiRoot)) {
  console.error(`[link-local-sdk] pi-mono-li root not found: ${monoLiRoot} (set PI_MONO_LI_ROOT)`)
  process.exit(1)
}

mkdirSync(scopeDir, { recursive: true })

const copyMode = process.env.PI_MONO_LI_LINK_MODE === 'copy'
let linked = 0
let kept = 0
let copied = 0
for (const [pkgDir, pkgName] of LINKS) {
  const target = join(monoLiRoot, pkgDir)
  const linkPath = join(scopeDir, pkgName)
  if (!existsSync(join(target, 'package.json'))) {
    console.error(`[link-local-sdk] missing package: ${target}`)
    process.exit(1)
  }
  if (copyMode) {
    rmSync(linkPath, { recursive: true, force: true })
    cpSync(target, linkPath, {
      recursive: true,
      dereference: false,
      filter: (src) => {
        const rel = relative(target, src)
        if (!rel) return true
        const top = rel.split(sep)[0]
        return top !== 'node_modules' && top !== '.git'
      },
    })
    copied++
    continue
  }
  if (existsSync(linkPath)) {
    const st = statSync(linkPath)
    if (!st.isSymbolicLink()) {
      // A real copy (e.g. an npm install without this script) is stale by definition —
      // the fork builds move; replace it so runtime imports always see the fork.
      rmSync(linkPath, { recursive: true, force: true })
    } else {
      kept++
      continue
    }
  }
  symlinkSync(target, linkPath, 'dir')
  linked++
}

console.log(`[link-local-sdk] root=${monoLiRoot} mode=${copyMode ? 'copy' : 'symlink'}`)
console.log(`[link-local-sdk] linked=${linked} kept=${kept} copied=${copied} (${LINKS.length} total)`)
