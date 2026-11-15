import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionFileWatcher, registerExternalChangeTarget, registeredExternalChangeTargetCount, type ExternalChangeTarget, type SessionFileChangeSignal } from './session-file-watcher'

/**
 * Poll-only path over REAL temp files: the gate math is driven by an injectable clock while
 * stamps come from the real filesystem (stat), exactly like production.
 */

let dir: string
let file: string
let clock = 0
const emitted: SessionFileChangeSignal[] = []
let reads = 0
const cleanups: Array<() => void> = []

function target(overrides: Partial<ExternalChangeTarget> = {}): ExternalChangeTarget & { signals: SessionFileChangeSignal[] } {
  const self: ExternalChangeTarget & { signals: SessionFileChangeSignal[] } = {
    signals: [],
    observedSessionFiles: () => [file],
    onExternalChange: async (f) => {
      reads++
      return { status: 'processed', signal: { sessionFile: f, running: false } }
    },
    onWatchTick: async () => [],
    ...overrides,
  }
  return self
}

function watcher(t: ExternalChangeTarget): SessionFileWatcher {
  cleanups.push(registerExternalChangeTarget(t))
  return new SessionFileWatcher(
    (signal) => {
      emitted.push(signal)
      ;(t as ExternalChangeTarget & { signals: SessionFileChangeSignal[] }).signals.push(signal)
    },
    () => clock,
  )
}

/** Distinct file content + explicit mtime so the stamp surely changes. */
async function touch(content: string, mtimeMs: number): Promise<void> {
  await writeFile(file, content, 'utf8')
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lix-watcher-'))
  file = join(dir, 'session.jsonl')
  await touch('a', 0)
  clock = 0
  reads = 0
  emitted.length = 0
})

afterEach(async () => {
  for (const un of cleanups.splice(0)) un()
  await rm(dir, { recursive: true, force: true })
})

describe('SessionFileWatcher', () => {
  it('poll detects a stamp change and emits the reconcile signal', async () => {
    const t = target()
    const w = watcher(t)
    await w.tick()
    expect(reads).toBe(1) // first sighting reads once
    await w.tick()
    expect(reads).toBe(1) // stamp unchanged: nothing new
    expect(emitted).toHaveLength(1)

    await touch('b', 3000)
    clock = 3000
    await w.tick() // stamp changed but the 5s gate from t=0 is still closed
    expect(reads).toBe(1)

    clock = 6000
    await w.tick()
    expect(reads).toBe(2)
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toEqual({ sessionFile: file, running: false })
  })

  it('re-reads at most once per 5s per file, and unchanged stamps never reset the gate', async () => {
    const t = target()
    const w = watcher(t)
    await w.tick() // t=0: read #1 (stamp A)
    expect(reads).toBe(1)

    await touch('b', 1000)
    clock = 1000
    await w.tick() // gate closed (1s < 5s): pending, no read
    expect(reads).toBe(1)

    // Ticks with an unchanged stamp must NOT reset the gate: the read goes through at t=5000
    // (5s since t=0). A gate reset on every tick would postpone it to t≈9000.
    clock = 2000
    await w.tick()
    clock = 3000
    await w.tick()
    clock = 4000
    await w.tick()
    clock = 5000
    await w.tick()
    expect(reads).toBe(2)

    clock = 6000
    await w.tick()
    expect(reads).toBe(2)
  })

  it('drops the signal when the file moved during the read (stat before/after), then re-reads', async () => {
    const t = target({
      onExternalChange: async (f) => {
        reads++
        // A concurrent writer appends only under the FIRST read; later reads see a stable file.
        if (reads === 1) await touch('1', 1001)
        return { status: 'processed', signal: { sessionFile: f, running: false } }
      },
    })
    const w = watcher(t)
    await w.tick() // t=0: read #1 (stamp A, writer moved it to stamp B → dropped)
    expect(reads).toBe(1)
    expect(emitted).toHaveLength(0)

    clock = 1000
    await w.tick() // gate closed again
    expect(reads).toBe(1)

    clock = 5000
    await w.tick() // read the newer stamp; file stable now → signal goes through
    expect(reads).toBe(2)
    expect(emitted).toHaveLength(1)
  })

  it('poll-only path: a change reaches clients within the SLO budget measured from the stat sighting', async () => {
    const t = target()
    const w = watcher(t)
    await w.tick() // baseline read at t=0
    expect(t.signals).toHaveLength(1)

    await touch('b', 3000)
    clock = 3000 // poll sees the new stamp here (stat observation moment)
    await w.tick() // gate from t=0 still closed
    expect(t.signals).toHaveLength(1)

    clock = 6000 // next poll: gate open → reconcile + emit
    await w.tick()
    expect(t.signals).toHaveLength(2)
    // SLO (measured from the stat sighting at t=3000): 3000ms to the patch signal (≤5s phone),
    // +1.5s renderer debounce = 4500ms (≤7s desktop).
    expect(clock - 3000).toBeLessThanOrEqual(5000)
  })

  it('a torn/failed read consumes the 5s gate but does not commit its stamp; it retries later', async () => {
    const t = target({
      onExternalChange: async () => {
        reads++
        return reads === 1 ? { status: 'retry' } : { status: 'processed' }
      },
    })
    const w = watcher(t)
    await w.tick() // first attempt fails
    expect(reads).toBe(1)
    await w.tick() // same stamp, retry gate closed
    expect(reads).toBe(1)
    clock = 5000
    await w.tick() // retry after the backoff; stamp is still uncommitted
    expect(reads).toBe(2)
  })

  it('a deferred slot arbitration does not consume the read gate and retries every poll', async () => {
    const t = target({
      onExternalChange: async (f) => {
        reads++
        return reads === 1 ? { status: 'processed' } : reads === 2 ? { status: 'deferred' } : { status: 'processed', signal: { sessionFile: f, running: false } }
      },
    })
    const w = watcher(t)
    await w.tick() // seed stamp
    await touch('b', 6000)
    clock = 6000
    await w.tick() // deferred: no gate consumed
    expect(reads).toBe(2)
    clock = 6001
    await w.tick() // no 5s wait after defer; next poll immediately rechecks
    expect(reads).toBe(3)
  })

  it('start/stop does not leak the interval', async () => {
    vi.useFakeTimers()
    try {
      const t = target()
      const w = watcher(t)
      const spy = vi.spyOn(w, 'tick')
      w.start()
      await vi.advanceTimersByTimeAsync(3000)
      expect(spy).toHaveBeenCalledTimes(1)
      w.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(spy).toHaveBeenCalledTimes(1) // no ticks after stop
    } finally {
      vi.useRealTimers()
    }
  })

  it('target registration is ref-counted by the module registry', () => {
    expect(registeredExternalChangeTargetCount()).toBe(0)
    const un = registerExternalChangeTarget(target())
    expect(registeredExternalChangeTargetCount()).toBe(1)
    un()
    expect(registeredExternalChangeTargetCount()).toBe(0)
  })
})
