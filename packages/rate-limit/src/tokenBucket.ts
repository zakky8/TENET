/**
 * Token bucket — the workhorse primitive of per-platform rate-limiting.
 *
 * Semantics:
 *   - capacity: max tokens the bucket can hold
 *   - refillTokensPerSec: how fast tokens drip back in
 *   - tryAcquire(n=1): synchronously remove n tokens if available
 *   - acquire(n=1): wait until n tokens are available
 *
 * Time is injectable so tests don't have to sleep. Production passes
 * `() => Date.now()`; tests pass a mutable clock.
 */
export interface TokenBucketOptions {
  capacity: number;
  refillTokensPerSec: number;
  /** Initial tokens — defaults to capacity (bucket starts full). */
  initialTokens?: number;
  /** Time source in ms — defaults to Date.now. */
  now?: () => number;
  /** Sleep function for acquire() — defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: TokenBucketOptions) {
    if (opts.capacity <= 0) {
      throw new Error('TokenBucket: capacity must be > 0');
    }
    if (opts.refillTokensPerSec <= 0) {
      throw new Error('TokenBucket: refillTokensPerSec must be > 0');
    }
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tokens = opts.initialTokens ?? opts.capacity;
    this.lastRefillMs = this.now();
  }

  /** Current token count after refill. Useful for tests + telemetry. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Try to take n tokens without waiting. Returns true if successful. */
  tryAcquire(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /**
   * Block until n tokens are available, then take them.
   * Throws if n > capacity (would never succeed).
   * If signal is aborted while waiting, throws AbortError.
   */
  async acquire(n = 1, signal?: AbortSignal): Promise<void> {
    if (n > this.opts.capacity) {
      throw new Error(
        `TokenBucket.acquire(${n}): exceeds capacity ${this.opts.capacity} — would deadlock`,
      );
    }
    while (true) {
      if (signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const deficit = n - this.tokens;
      const msToWait = Math.ceil((deficit / this.opts.refillTokensPerSec) * 1000);
      await this.sleep(Math.max(1, msToWait));
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    if (elapsedMs === 0) return;
    const newTokens = (elapsedMs / 1000) * this.opts.refillTokensPerSec;
    this.tokens = Math.min(this.opts.capacity, this.tokens + newTokens);
    this.lastRefillMs = now;
  }
}
