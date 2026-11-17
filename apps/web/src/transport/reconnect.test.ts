import { describe, expect, it } from 'vitest'
import { ReconnectBackoff } from './reconnect'

describe('reconnect backoff (spec T3: exponential + jitter)', () => {
  it('grows exponentially from the base, capped at capMs', () => {
    const b = new ReconnectBackoff({ baseMs: 500, factor: 2, capMs: 8000, jitter: 0, rng: () => 0.5 })
    expect(b.nextDelay()).toBe(500)
    expect(b.nextDelay()).toBe(1000)
    expect(b.nextDelay()).toBe(2000)
    expect(b.nextDelay()).toBe(4000)
    expect(b.nextDelay()).toBe(8000)
    expect(b.nextDelay()).toBe(8000) // capped, not 16s
  })

  it('jitter stays within the half-width band around the nominal delay', () => {
    const nominal = [500, 1000, 2000, 4000, 8000]
    const b = new ReconnectBackoff({ baseMs: 500, factor: 2, capMs: 30_000, jitter: 0.25, rng: Math.random })
    nominal.forEach((n, i) => {
      const d = b.nextDelay() as number
      expect(d).toBeGreaterThanOrEqual(n * 0.75)
      expect(d).toBeLessThanOrEqual(n * 1.25)
      expect(d).toBe(Math.round(d))
      void i
    })
  })

  it('resets after success and stops at maxAttempts', () => {
    const b = new ReconnectBackoff({ baseMs: 500, factor: 2, capMs: 8000, jitter: 0, maxAttempts: 3, rng: () => 0.5 })
    expect(b.nextDelay()).toBe(500)
    expect(b.nextDelay()).toBe(1000)
    expect(b.nextDelay()).toBe(2000)
    expect(b.nextDelay()).toBeNull() // budget exhausted
    b.reset()
    expect(b.attempt).toBe(0)
    expect(b.nextDelay()).toBe(500)
  })

  it('rng extremes produce the full jitter band endpoints', () => {
    const low = new ReconnectBackoff({ baseMs: 1000, factor: 1, capMs: 10_000, jitter: 0.5, rng: () => 0 })
    const high = new ReconnectBackoff({ baseMs: 1000, factor: 1, capMs: 10_000, jitter: 0.5, rng: () => 1 })
    expect(low.nextDelay()).toBe(500)
    expect(high.nextDelay()).toBe(1500)
  })
})
