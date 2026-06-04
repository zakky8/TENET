/**
 * Circuit breaker for outbound API calls.
 *
 * Discord's `10k invalid (401/403/429) requests / 10 minutes → ~24h
 * Cloudflare IP ban` floor (verified in pass-1 research) means a blind
 * retry loop on auth failures is a liveness risk for the whole egress
 * IP. This breaker tracks consecutive auth failures and opens at a
 * configurable threshold; while open, any call is rejected immediately
 * with a typed error.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Open after this many CONSECUTIVE auth failures (401/403). Default 100. */
  failureThreshold?: number;
  /** Cool-down before transitioning open → half_open (ms). Default 60_000. */
  cooldownMs?: number;
  /** Time source. */
  now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 100;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    if (this.failureThreshold <= 0) {
      throw new Error('CircuitBreaker: failureThreshold must be > 0');
    }
    if (this.cooldownMs <= 0) {
      throw new Error('CircuitBreaker: cooldownMs must be > 0');
    }
  }

  /** State after applying any pending open→half_open transition. */
  currentState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half_open';
    }
    return this.state;
  }

  /** True iff a call should be permitted right now. */
  allow(): boolean {
    return this.currentState() !== 'open';
  }

  /** Record a successful call. Resets failure streak; closes a half-open breaker. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  /**
   * Record an auth failure (401 / 403). 429s do NOT count — those are
   * rate-limit signals and are handled by the TokenBucket.
   */
  recordAuthFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /** Current consecutive-failure count. */
  failureCount(): number {
    return this.consecutiveFailures;
  }
}

/** Typed error thrown when a call is rejected by an open breaker. */
export class CircuitOpenError extends Error {
  constructor(message = 'circuit breaker is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}
