/**
 * Retryable-vs-fatal error taxonomy for outbound calls.
 *
 * The first question a resilience layer must answer before ANY retry or
 * cross-provider failover: is this error worth retrying at all? Retrying
 * the wrong class is actively harmful —
 *   - a cancelled request (AbortError) must STAY cancelled: retrying
 *     defeats the cancellation and can duplicate a partially-applied side
 *     effect;
 *   - a 4xx client error (bad request, bad auth, not found) fails
 *     identically on every attempt while burning budget, and for
 *     401/403/429 a blind retry loop risks an egress-IP ban (see
 *     CircuitBreaker).
 *
 * So only KNOWN-transient errors are retryable; anything unrecognized is
 * FATAL, so a non-idempotent call is never blindly re-sent on an error we
 * cannot classify. (429/408 are retryable, but only WITH backoff — this
 * taxonomy answers "may I retry?", the backoff + breaker answer "how
 * hard?".)
 */

export type RetryClass = 'retryable' | 'fatal';

export interface RetryClassification {
  retryClass: RetryClass;
  reason: string;
}

/** Socket / DNS error codes that are safe-to-retry transient failures. */
const RETRYABLE_CODES = new Set<string>([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

function readString(err: unknown, key: string): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const v = (err as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

function readNumber(err: unknown, key: string): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const v = (err as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Classify an unknown thrown value as retryable or fatal. Duck-typed on
 * `name` (AbortError), a numeric `status` (HTTP), and a `code` string
 * (socket/DNS) so it works across model adapters and `fetch`
 * implementations without importing any of them.
 */
export function classifyError(err: unknown): RetryClassification {
  // 1. Cancellation is intentional — NEVER retry.
  if (readString(err, 'name') === 'AbortError') {
    return { retryClass: 'fatal', reason: 'aborted (cancellation is intentional)' };
  }

  // 2. HTTP status.
  const status = readNumber(err, 'status');
  if (status !== undefined) {
    if (status === 429 || status === 408) {
      return { retryClass: 'retryable', reason: `${status} (transient — retry with backoff)` };
    }
    if (status >= 500 && status <= 599) {
      return { retryClass: 'retryable', reason: `${status} (server error — transient)` };
    }
    if (status >= 400 && status <= 499) {
      return { retryClass: 'fatal', reason: `${status} (client error — a retry fails identically)` };
    }
    return { retryClass: 'fatal', reason: `status ${status} (not a known-transient class)` };
  }

  // 3. Transient socket / DNS failures.
  const code = readString(err, 'code');
  if (code !== undefined && RETRYABLE_CODES.has(code)) {
    return { retryClass: 'retryable', reason: `${code} (transient network error)` };
  }

  // 4. Fail CLOSED: an unrecognized error is NOT retried — a non-idempotent
  //    call must never be blindly re-sent on an error we cannot classify.
  return { retryClass: 'fatal', reason: 'unrecognized error — not retried (side-effect-safe default)' };
}

/** Convenience predicate over classifyError. */
export function isRetryable(err: unknown): boolean {
  return classifyError(err).retryClass === 'retryable';
}
