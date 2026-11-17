// Worker-side owner protocol bridge (SPEC-2026-11-16-li-web, T2).
//
// The pi SDK (pi-mono-li T1 build) ships the session owner protocol in
// `dist/core/session-owner-protocol.js`, but the package entry does not
// re-export it (public surface is `.` and `./rpc-entry` only). The worker is
// the process that OWNS AgentSessions, so it needs three things from that
// module: strict-mode activation before any session is constructed, the
// successor handoff claim (PI_SESSION_OWNER_CLAIM) before a session opens,
// and the protocol version for the host handshake. Everything here degrades
// to "no owner protocol" when the loaded SDK predates T1, so older SDKs keep
// working exactly as before.
//
// Module loading happens via native dynamic import of an absolute file URL —
// the Electron utility process is a plain Node runtime, so this works for
// builtin (node_modules), global and user-installed SDK roots alike. Tests
// inject `importer`/`candidates` because the vitest loader refuses native
// imports outside the project root.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface OwnerProtocolModule {
  OWNER_PROTOCOL_VERSION: number
  claimSessionHandoffFromEnv: (env?: NodeJS.ProcessEnv, deps?: { exit?: (code: number) => never }) => void
}

export type ResolvedOwnerProtocol = {
  module: OwnerProtocolModule | null
  version: number | null
}

export type OwnerProtocolDeps = {
  candidates?: (sdkEntryPath: string | null) => string[]
  importer?: (href: string) => Promise<unknown>
}

let resolved: ResolvedOwnerProtocol | null = null

/** Reset the memoized resolution (tests only). */
export function resetOwnerProtocolCache(): void {
  resolved = null
}

/** Candidate module locations: SDK entry (`…/dist/index.js`) or the package resolved from node_modules. */
export function ownerProtocolCandidates(sdkEntryPath: string | null): string[] {
  const out: string[] = []
  const roots: string[] = []
  if (sdkEntryPath) {
    const dir = dirname(sdkEntryPath)
    // Entry is `dist/index.js` (or `dist/bundle/…`): walk up to the dir that holds `core/`.
    roots.push(dir, dirname(dir), dirname(dirname(dir)))
  }
  try {
    // Builtin dependency: resolve the installed package root (works from src, out/ and asar-unpacked).
    const pkgUrl = import.meta.resolve('@earendil-works/pi-coding-agent/package.json')
    roots.push(dirname(fileURLToPath(pkgUrl)))
  } catch {
    try {
      // Fallback when subpath resolve is unavailable: walk up from this module to a node_modules.
      roots.push(join(fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent', import.meta.url))))
    } catch {
      /* ignore */
    }
  }
  for (const root of roots) {
    out.push(join(root, 'dist', 'core', 'session-owner-protocol.js'))
    out.push(join(root, 'core', 'session-owner-protocol.js'))
  }
  return out
}

/** Resolve (and cache) the owner-protocol module for this worker's SDK. */
export async function resolveOwnerProtocol(sdkEntryPath: string | null, deps?: OwnerProtocolDeps): Promise<ResolvedOwnerProtocol> {
  if (!deps && resolved) return resolved
  const found: ResolvedOwnerProtocol = { module: null, version: null }
  const importer = deps?.importer ?? ((href: string) => import(href))
  for (const candidate of (deps?.candidates ?? ownerProtocolCandidates)(sdkEntryPath)) {
    if (!candidate.endsWith('.js') || !existsSync(candidate)) continue
    try {
      const mod = (await importer(pathToFileURL(candidate).href)) as Partial<OwnerProtocolModule>
      if (mod && typeof mod.claimSessionHandoffFromEnv === 'function' && typeof mod.OWNER_PROTOCOL_VERSION === 'number') {
        found.module = mod as OwnerProtocolModule
        found.version = mod.OWNER_PROTOCOL_VERSION
        break
      }
    } catch {
      /* try next candidate */
    }
  }
  // Cache every definite result so later no-deps callers reuse it; null results only cache
  // for the no-deps path (a deps-injected probe must not poison the real resolution).
  if (!deps || found.module) resolved = found
  return found
}

/**
 * Cross-client runtimes (the LiX worker) must refuse writes when the lease
 * registry cannot prove exclusive ownership. The SDK reads this env var at
 * AgentSession construction, so it must be set BEFORE any session opens.
 * Local TUI stays non-strict (SDK default) — only this worker process flips.
 */
export async function enableOwnerStrictMode(sdkEntryPath: string | null, deps?: OwnerProtocolDeps): Promise<number | null> {
  const { module, version } = await resolveOwnerProtocol(sdkEntryPath, deps)
  if (!module) return null
  process.env.PI_SESSION_OWNER_STRICT = '1'
  return version
}

/**
 * Successor handoff claim: when the host spawns a worker to take over a
 * session another LiX worker released via beginSessionHandoff, it passes
 * PI_SESSION_OWNER_CLAIM=agentDir|pathHash|token|sessionId in the fork env.
 * Must run BEFORE the session opens; the helper consumes the env var and
 * exits the worker with a typed message when the claim fails.
 */
export async function claimOwnerHandoffFromEnv(
  sdkEntryPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
  deps?: OwnerProtocolDeps & { exit?: (code: number) => never },
): Promise<void> {
  if (!env.PI_SESSION_OWNER_CLAIM) return
  const { module } = await resolveOwnerProtocol(sdkEntryPath, deps)
  if (!module) {
    // Claim requested but this SDK cannot honor it: fail loudly, not silently unguarded.
    delete env.PI_SESSION_OWNER_CLAIM
    process.stderr.write('PI_SESSION_OWNER_CLAIM set but SDK has no owner protocol module\n')
    ;(deps?.exit ?? process.exit)(1)
    return
  }
  module.claimSessionHandoffFromEnv(env, deps ? { exit: deps.exit } : undefined)
}

/** Classify an SDK error into the remote wire code for a mutating RPC failure. */
export function classifyOwnerError(error: unknown): { code: 'writer_conflict' | 'owner_unavailable' | null; ownerPid?: number; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  const code = (error as { code?: string } | null)?.code
  if (name === 'SessionOwnerUnavailableError' || (error instanceof Error && code === 'owner_unavailable')) {
    return { code: 'owner_unavailable', message }
  }
  // Lease acquire failure naming a live writer is a conflict; parse the owner pid when present.
  if (message.includes('writer_conflict') || message.includes('owned by a live writer')) {
    const m = /pid (\d+)/.exec(message)
    return { code: 'writer_conflict', ...(m ? { ownerPid: Number(m[1]) } : {}), message }
  }
  if (message.includes('owner lease') || message.includes('SessionDataLockedError') || name === 'SessionDataLockedError') {
    return { code: 'writer_conflict', message }
  }
  return { code: null, message }
}
