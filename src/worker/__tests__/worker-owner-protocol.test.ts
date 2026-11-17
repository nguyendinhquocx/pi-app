import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyOwnerError,
  claimOwnerHandoffFromEnv,
  enableOwnerStrictMode,
  ownerProtocolCandidates,
  resetOwnerProtocolCache,
  resolveOwnerProtocol,
  type OwnerProtocolModule,
} from '../worker-owner-protocol'

/**
 * T2 worker owner-protocol bridge. The vitest loader refuses native imports outside the
 * project root, so resolution/strict/claim flows run with an injected importer while the
 * candidate derivation stays pure. The real native-import path is exercised in production
 * (the Electron utility process is a plain Node runtime) and again at T5 on both hosts.
 */

const SDK_ENTRY = join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')

const fakeModule = (): OwnerProtocolModule => ({
  OWNER_PROTOCOL_VERSION: 1,
  claimSessionHandoffFromEnv: (env, deps) => {
    const raw = env?.PI_SESSION_OWNER_CLAIM
    if (!raw) return
    delete env.PI_SESSION_OWNER_CLAIM
    const parts = raw.split('|')
    if (parts.length !== 4) {
      ;(deps?.exit ?? process.exit)(1)
    }
  },
})

describe('worker owner protocol bridge', () => {
  it('derives dist/core candidates from the SDK entry path', () => {
    const cands = ownerProtocolCandidates(SDK_ENTRY)
    expect(cands).toContain(join(SDK_ENTRY, '..', 'core', 'session-owner-protocol.js'))
  })

  it('resolves via an injected importer and memoizes the result', async () => {
    resetOwnerProtocolCache()
    let calls = 0
    const importer = async (href: string) => {
      calls++
      expect(href.endsWith('.js')).toBe(true)
      return fakeModule()
    }
    const r = await resolveOwnerProtocol(SDK_ENTRY, { importer, candidates: () => [SDK_ENTRY] })
    expect(r.version).toBe(1)
    // A later no-deps caller reuses the memoized module (same SDK for the process lifetime).
    const r2 = await resolveOwnerProtocol(SDK_ENTRY)
    expect(r2.version).toBe(1)
    expect(calls).toBe(1) // memoized
    resetOwnerProtocolCache()
  })

  it('degrades to no owner protocol when the SDK predates T1', async () => {
    resetOwnerProtocolCache()
    const r = await resolveOwnerProtocol(SDK_ENTRY, { importer: async () => ({}), candidates: () => [SDK_ENTRY] })
    expect(r.module).toBeNull()
    expect(r.version).toBeNull()
    resetOwnerProtocolCache()
  })

  it('enabling strict mode sets the SDK env flag and returns the protocol version', async () => {
    resetOwnerProtocolCache()
    const before = process.env.PI_SESSION_OWNER_STRICT
    const v = await enableOwnerStrictMode(SDK_ENTRY, { importer: async () => fakeModule(), candidates: () => [SDK_ENTRY] })
    expect(v).toBe(1)
    expect(process.env.PI_SESSION_OWNER_STRICT).toBe('1')
    if (before === undefined) delete process.env.PI_SESSION_OWNER_STRICT
    else process.env.PI_SESSION_OWNER_STRICT = before
    resetOwnerProtocolCache()
  })

  it('classifies live-writer acquire failures as writer_conflict with the owner pid', () => {
    const err = new Error('cannot acquire session owner lease: session is owned by a live writer (pid 4242); use handoff, not force-acquire')
    expect(classifyOwnerError(err)).toMatchObject({ code: 'writer_conflict', ownerPid: 4242 })
  })

  it('classifies strict registry unavailability as owner_unavailable', () => {
    const err = new Error('strict writer mode requires the lease registry: registry dir missing')
    ;(err as Error & { code?: string }).code = 'owner_unavailable'
    expect(classifyOwnerError(err).code).toBe('owner_unavailable')
  })

  it('passes unknown errors through unclassified', () => {
    expect(classifyOwnerError(new Error('model x unavailable')).code).toBeNull()
    expect(classifyOwnerError('string error').code).toBeNull()
  })

  it('successor claim consumes the env var and fails closed on malformed payloads', async () => {
    resetOwnerProtocolCache()
    const exits: number[] = []
    const env: NodeJS.ProcessEnv = { PI_SESSION_OWNER_CLAIM: 'not-a-claim' }
    await expect(
      claimOwnerHandoffFromEnv(SDK_ENTRY, env, {
        importer: async () => fakeModule(),
        candidates: () => [SDK_ENTRY],
        exit: ((code: number) => {
          exits.push(code)
          throw new Error(`exit ${code}`)
        }) as never,
      }),
    ).rejects.toThrow('exit 1')
    expect(env.PI_SESSION_OWNER_CLAIM).toBeUndefined()
    expect(exits).toEqual([1])
    resetOwnerProtocolCache()
  })

  it('a well-formed claim reaches the SDK claim entry and clears the env var', async () => {
    resetOwnerProtocolCache()
    const seen: string[] = []
    const env: NodeJS.ProcessEnv = { PI_SESSION_OWNER_CLAIM: 'agent|hash|tok|sid' }
    const mod = fakeModule()
    const orig = mod.claimSessionHandoffFromEnv
    mod.claimSessionHandoffFromEnv = (e) => {
      seen.push(String(e?.PI_SESSION_OWNER_CLAIM))
      delete e?.PI_SESSION_OWNER_CLAIM
    }
    await claimOwnerHandoffFromEnv(SDK_ENTRY, env, { importer: async () => mod, candidates: () => [SDK_ENTRY] })
    expect(seen).toEqual(['agent|hash|tok|sid'])
    expect(env.PI_SESSION_OWNER_CLAIM).toBeUndefined()
    mod.claimSessionHandoffFromEnv = orig
    resetOwnerProtocolCache()
  })
})
