// Post-packaging smoke: extract the built app.asar and prove the packaged module
// layout actually RESOLVES at runtime — the check that was missing before the
// 2026-11-20 host-2 incident (asar shipped without chalk; boot crashed with
// ERR_MODULE_NOT_FOUND while all symbol-level checks passed).
//
// Usage: node scripts/smoke-packaged-asar.mjs <path-to-app.asar>
//
// It extracts the asar (the extraction layout equals what Electron exposes inside
// the archive), then, with the extracted dir as the resolution root:
//   1. imports the exact file that crashed in the incident (SDK dist/cli/args.js),
//   2. imports the T1 owner-protocol module (dist/core/session-open-lease.js),
//   3. imports one entry module from each fork package,
//   4. imports chalk + every remaining audited fork dependency from the flat tree.
// Any import failure exits non-zero with the failing specifier listed.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asarPath = resolve(process.argv[2] ?? join(repoRoot, 'dist', 'linux-unpacked', 'resources', 'app.asar'))
if (!existsSync(asarPath)) {
  console.error(`[smoke] asar not found: ${asarPath}`)
  process.exit(1)
}

const workDir = mkdtempSync(join(tmpdir(), 'lix-asar-smoke-'))
const extractDir = join(workDir, 'app')

try {
  const asarBin = join(repoRoot, 'node_modules', '.bin', existsSync(join(repoRoot, 'node_modules', '.bin', 'asar')) ? 'asar' : 'asar.cmd')
  execFileSync(asarBin, ['extract', asarPath, extractDir], { stdio: 'pipe', shell: process.platform === 'win32' })

  // Resolution root = extracted dir: a module placed at <extract>/app/x.js resolves
  // node_modules by walking up from its own path, exactly like inside app.asar.
  const probeDir = join(extractDir, '__smoke__')
  cpSync(join(repoRoot, 'scripts'), join(probeDir, 'scripts'), { recursive: true })
  const smokeEntry = join(probeDir, 'scripts', 'smoke-probe.mjs')
  const requireFromApp = createRequire(join(repoRoot, 'package.json'))
  let forkDeps = []
  try {
    for (const [, name] of [
      ['packages/coding-agent', '@earendil-works/pi-coding-agent'],
    ]) {
      const manifest = JSON.parse(requireFromApp(join(process.env.PI_MONO_LI_ROOT ?? resolve(repoRoot, '..', '..', '..', 'pi-mono-li'), 'packages/coding-agent', 'package.json')))
      forkDeps = Object.keys(manifest.dependencies ?? {})
    }
  } catch {
    forkDeps = ['chalk']
  }

  const result = execFileSync(process.execPath, [smokeEntry], {
    cwd: extractDir,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      SMOKE_ROOT: extractDir,
      SMOKE_DEPS: JSON.stringify(forkDeps),
    },
  })
  console.log(result.trim())
  console.log('[smoke] PASS — packaged asar resolves all probe imports')
} catch (error) {
  const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout) : ''
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : String(error)
  if (stdout.trim()) console.error(stdout.trim())
  console.error(`[smoke] FAIL — packaged asar does not resolve all probe imports:\n${stderr.trim()}`)
  process.exitCode = 1
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
