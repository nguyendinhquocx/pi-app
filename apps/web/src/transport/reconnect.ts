/**
 * Reconnect policy (spec T3 UX contract): exponential backoff with jitter so a fleet of web
 * tabs waking from sleep does not stampede the host. Per attempt: delay = min(cap,
 * base * factor^(attempt-1)) * uniform(1 - jitter, 1 + jitter). A successful handshake resets
 * the attempt counter. Deterministic rng injection keeps the policy testable.
 */
export type BackoffOptions = {
  baseMs?: number
  factor?: number
  capMs?: number
  /** Relative jitter half-width, e.g. 0.25 → delay ∈ [75%, 125%] of the nominal delay. */
  jitter?: number
  maxAttempts?: number
  /** Injected for tests; defaults to Math.random. */
  rng?: () => number
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'rng'>> = {
  baseMs: 500,
  factor: 2,
  capMs: 30_000,
  jitter: 0.25,
  maxAttempts: Infinity,
}

export class ReconnectBackoff {
  private attempts = 0
  private readonly opts: Required<Omit<BackoffOptions, 'rng'>> & { rng: () => number }

  constructor(options: BackoffOptions = {}) {
    this.opts = { ...DEFAULT_BACKOFF, rng: Math.random, ...options }
  }

  /** Milliseconds to wait before the next attempt, or null when the budget is exhausted. */
  nextDelay(): number | null {
    if (this.attempts >= this.opts.maxAttempts) return null
    this.attempts++
    const nominal = Math.min(this.opts.capMs, this.opts.baseMs * Math.pow(this.opts.factor, this.attempts - 1))
    const j = this.opts.jitter
    const delay = nominal * (1 - j + this.opts.rng() * 2 * j)
    return Math.max(0, Math.round(delay))
  }

  /** Handshake succeeded — the next failure starts from the base delay again. */
  reset(): void {
    this.attempts = 0
  }

  get attempt(): number {
    return this.attempts
  }
}
