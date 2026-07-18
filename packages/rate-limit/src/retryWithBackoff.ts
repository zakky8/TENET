/**
 * Retry an outbound call with jittered exponential backoff — fail CLOSED.
 *
 * The default retry decision is the `isRetryable` taxonomy, so a fatal
 * error (AbortError, 4xx, or anything unrecognized) is NEVER retried: it
 * is re-thrown on the first attempt, with no backoff. Only known-transient
 * errors (429/408, 5xx, transient socket codes) are retried. This is the
 * opposite of a "retry any throw" default, which would re-send a cancelled
 * or non-idempotent call.
 *
 * Backoff is exponential with FULL JITTER by default (delay ∈ (0, base]),
 * which de-correlates concurrent clients and avoids a synchronized
 * thundering-herd on a recovering upstream. `sleep` and `random` are
 * injectable so the schedule is deterministic under test.
 */

import { isRetryable, isAuthFailure } from './retryClass.js';
import { CircuitOpenError } from './circuitBreaker.js';

/**
 * Minimal breaker surface retryWithBackoff consumes — structurally
 * satisfied by CircuitBreaker. Kept structural so it stays testable with a
 * fake and never forces a concrete instance on callers who don't want one.
 */
export interface CircuitBreakerLike {
  /** False when the breaker is OPEN — the call must be short-circuited. */
  allow(): boolean;
  /** A successful call resets the failure streak / closes a half-open breaker. */
  recordSuccess(): void;
  /** An auth failure (401/403) counts toward opening the breaker. */
  recordAuthFailure(): void;
}

export interface RetryBackoffOptions {
  /** Total attempts (not extra retries). Default 3. Must be > 0. */
  maxAttempts?: number;
  /** Base delay for attempt 1 (ms). Default 100. */
  initialDelayMs?: number;
  /** Multiplier per attempt. Default 2 (exponential). */
  backoffFactor?: number;
  /** Delay cap (ms), applied BEFORE jitter. Default 30_000. */
  maxDelayMs?: number;
  /**
   * Jitter fraction in [0,1]. The waited delay is
   * `base * (1 - jitter * random())`, so jitter=1 → (0, base] (full
   * jitter, the default), jitter=0 → exactly base (no jitter).
   */
  jitter?: number;
  /** Retry decision. Default `isRetryable` — the fail-closed taxonomy. */
  shouldRetry?: (err: unknown) => boolean;
  /** Cancellation. An abort during a backoff wait rejects immediately. */
  signal?: AbortSignal;
  /** Injected wait (for deterministic tests). Default an abort-aware timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected randomness in [0,1) (for deterministic tests). Default Math.random. */
  random?: () => number;
  /** Observability hook, called once per scheduled retry (before the wait). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /**
   * Optional circuit breaker. When OPEN, a call is short-circuited with a
   * `CircuitOpenError` BEFORE `fn` runs (never hammering a failing upstream);
   * a success resets it, and an auth failure (401/403) counts toward opening.
   */
  breaker?: CircuitBreakerLike;
}

function abortError(message: string): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

/** Abort-aware timer. Rejects with an AbortError if the signal fires. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError('sleep aborted'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError('sleep aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retryWithBackoff<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  opts: RetryBackoffOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  if (maxAttempts <= 0) throw new Error('retryWithBackoff: maxAttempts must be > 0');
  const initial = opts.initialDelayMs ?? 100;
  const factor = opts.backoffFactor ?? 2;
  const cap = opts.maxDelayMs ?? 30_000;
  const jitter = opts.jitter ?? 1;
  if (jitter < 0 || jitter > 1) throw new Error('retryWithBackoff: jitter must be in [0,1]');
  const shouldRetry = opts.shouldRetry ?? isRetryable;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  const breaker = opts.breaker;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Short-circuit an OPEN breaker BEFORE calling fn — do not hammer a
    // failing upstream (a blind loop on 401/403 risks an egress-IP ban).
    // CircuitOpenError is classified fatal, so it is never itself retried.
    if (breaker !== undefined && !breaker.allow()) {
      throw new CircuitOpenError();
    }
    try {
      const result = await fn(opts.signal);
      breaker?.recordSuccess();
      return result;
    } catch (e) {
      lastErr = e;
      // Only an auth failure (401/403) counts toward opening the breaker.
      if (isAuthFailure(e)) breaker?.recordAuthFailure();
      // Fail CLOSED: a fatal error is re-thrown immediately — no retry, no
      // backoff. Exhausting the attempts also surfaces the ORIGINAL error
      // (more useful than a wrapper), never a shipped fallback.
      if (attempt === maxAttempts || !shouldRetry(e)) throw e;
      const base = Math.min(cap, initial * factor ** (attempt - 1));
      const delayMs = base * (1 - jitter * random());
      opts.onRetry?.({ attempt, delayMs, error: e });
      await sleep(delayMs, opts.signal);
    }
  }
  // Unreachable — the loop always returns or throws — but satisfies the type.
  throw lastErr;
}
