/**
 * Shared timeout helper for ChatModel calls.
 *
 * Wires three behaviors that the previous Promise.race-only timeout
 * could not:
 *   1. The promise rejects with `${label} timeout after Nms` when the
 *      timer fires (same as before).
 *   2. The AbortController is aborted on the SAME tick so any HTTP
 *      client respecting the signal can cancel the in-flight request.
 *   3. The timer is cleared on success, so a successful call doesn't
 *      keep the Node event loop alive.
 *
 * Adversarial-review B3 fix: lifts a duplicated withTimeout out of
 * claimExtractor.ts + judge.ts into one place that does it right.
 */
export async function withTimeoutAndSignal<T>(
  build: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const ctrl = new AbortController();
  // ES2024 Promise.withResolvers() replaces the hand-rolled executor:
  // no closure-over-timer pattern, no `let timer` outside the Promise body,
  // and the reject handle is held cleanly for the setTimeout callback.
  const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    ctrl.abort();
    reject(new Error(`${label} timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await Promise.race([build(ctrl.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
