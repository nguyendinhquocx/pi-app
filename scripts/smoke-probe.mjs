// Probe executed INSIDE the extracted asar layout (cwd = extracted root).
// SMOKE_ROOT = extraction root; SMOKE_DEPS = JSON array of fork npm dependency names.
// Every dynamic import below uses paths relative to SMOKE_ROOT so that Node's
// resolution walks the packaged flat node_modules exactly like inside app.asar.

const root = process.env.SMOKE_ROOT
const deps = JSON.parse(process.env.SMOKE_DEPS ?? '["chalk"]')
const { join } = await import('node:path')
const rel = (p) => `file://${root.replace(/\\/g, '/')}/${p}`

const probes = [
  ['incident repro: SDK cli/args.js', rel('node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js')],
  ['T1 owner protocol: session-open-lease.js', rel('node_modules/@earendil-works/pi-coding-agent/dist/core/session-open-lease.js')],
  ['pi-agent-core', rel('node_modules/@earendil-works/pi-agent-core/dist/index.js')],
  ['pi-ai', rel('node_modules/@earendil-works/pi-ai/dist/index.js')],
  ['pi-schema', rel('node_modules/@earendil-works/pi-schema/dist/index.js')],
  ['pi-tui', rel('node_modules/@earendil-works/pi-tui/dist/index.js')],
  ['pi-mcp', rel('node_modules/@earendil-works/pi-mcp/dist/index.js')],
  ['pi-codemode', rel('node_modules/@earendil-works/pi-codemode/dist/index.js')],
  ['pi-telemetry', rel('node_modules/@earendil-works/pi-telemetry/dist/index.js')],
]

const failures = []
for (const [label, specifier] of probes) {
  try {
    await import(specifier)
    console.log(`  ok: ${label}`)
  } catch (error) {
    failures.push(`${label} (${specifier}): ${error?.message ?? error}`)
  }
}

for (const dep of deps) {
  try {
    await import(dep)
  } catch {
    // Some deps are CJS-only or export named symbols that break bare dynamic import;
    // fall back to createRequire which mirrors CJS interop.
    try {
      const req = (await import('node:module')).createRequire(join(root, 'package.json'))
      req(dep)
    } catch (error) {
      failures.push(`dep ${dep}: ${error?.message ?? error}`)
    }
  }
}

if (failures.length > 0) {
  console.error(`[smoke-probe] ${failures.length} failures:`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`[smoke-probe] ${probes.length + deps.length} imports resolved from packaged layout`)
