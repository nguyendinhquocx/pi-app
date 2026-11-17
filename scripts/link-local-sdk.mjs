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

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  ['packages/tui', 'pi-tui'],
  ['packages/mcp', 'pi-mcp'],
  ['packages/codemode', 'pi-codemode'],
  ['packages/telemetry', 'pi-telemetry'],
]

if (!existsSync(monoLiRoot)) {
  console.error(`[link-local-sdk] pi-mono-li root not found: ${monoLiRoot} (set PI_MONO_LI_ROOT)`)
  process.exit(1)
}

mkdirSync(scopeDir, { recursive: true })

let linked = 0
let kept = 0
for (const [pkgDir, pkgName] of LINKS) {
  const target = join(monoLiRoot, pkgDir)
  const linkPath = join(scopeDir, pkgName)
  if (!existsSync(join(target, 'package.json'))) {
    console.error(`[link-local-sdk] missing package: ${target}`)
    process.exit(1)
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

console.log(`[link-local-sdk] root=${monoLiRoot}`)
console.log(`[link-local-sdk] linked=${linked} kept=${kept} (${LINKS.length} total)`)
