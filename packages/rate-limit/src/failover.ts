/**
 * Cross-provider failover — try providers in order, move to the next only
 * on a TRANSIENT failure, and fail CLOSED on a fatal one.
 *
 * The failover decision is the `isRetryable` taxonomy, so the chain fails
 * over on a 5xx / 429 / transient network error (the current provider is
 * unhealthy — try another), but NEVER on a fatal class:
 *   - an AbortError means the turn was cancelled — it must stay cancelled,
 *     not silently re-issued against a second provider;
 *   - a 4xx (bad request, bad auth, not found) is a client-side problem
 *     that fails identically on every provider — trying the next one just
 *     burns budget (and could duplicate a non-idempotent side effect).
 *
 * Orthogonal to `retryWithBackoff`: wrap each provider callable in
 * `retryWithBackoff` to retry transient errors ON that provider first, then
 * let `failover` move to the next provider once a provider's own retries are
 * exhausted. The two compose without either knowing about the other.
 */

import { isRetryable } from './retryClass.js';

export interface FailoverOptions {
  /**
   * Decide whether an error from the current provider should fail over to
   * the next. Default `isRetryable` — the fail-closed taxonomy (transient →
   * fail over; AbortError / 4xx / unrecognized → do NOT).
   */
  shouldFailover?: (err: unknown) => boolean;
  /** Cancellation, threaded to each provider callable. */
  signal?: AbortSignal;
  /** Observability hook, called once each time the chain moves to the next provider. */
  onFailover?: (info: { fromIndex: number; error: unknown }) => void;
}

/**
 * Run the first provider that succeeds. On a fail-over-eligible error, try
 * the next; on a fatal error (or the last provider), re-throw the ORIGINAL
 * error — never a shipped fallback and never a masked cancellation.
 */
export async function failover<T>(
  providers: ReadonlyArray<(signal?: AbortSignal) => Promise<T>>,
  opts: FailoverOptions = {},
): Promise<T> {
  if (providers.length === 0) throw new Error('failover: at least one provider required');
  const shouldFailover = opts.shouldFailover ?? isRetryable;

  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    try {
      return await providers[i]!(opts.signal);
    } catch (e) {
      lastErr = e;
      // Fail CLOSED: a fatal error (AbortError / 4xx / unrecognized) is
      // re-thrown immediately — the next provider would fail identically,
      // and a cancelled turn must never be re-issued elsewhere.
      if (i === providers.length - 1 || !shouldFailover(e)) throw e;
      opts.onFailover?.({ fromIndex: i, error: e });
    }
  }
  // Unreachable — the loop returns or throws — but satisfies the type.
  throw lastErr;
}
