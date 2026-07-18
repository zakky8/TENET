import { withTimeoutAndSignal } from './timeout.js';

describe('withTimeoutAndSignal — FIX B3', () => {
  it('rejects with "<label> timeout after Nms" when timer fires', async () => {
    await expect(
      withTimeoutAndSignal((_signal) => new Promise(() => {}), 30, 'test'),
    ).rejects.toThrow(/test timeout after 30ms/);
  });

  it('aborts the AbortController when the timer fires', async () => {
    let captured: AbortSignal | undefined;
    let wasAbortedAfterTimeout = false;
    const p = withTimeoutAndSignal(
      (signal) => {
        captured = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            wasAbortedAfterTimeout = true;
            reject(new Error('aborted'));
          });
        });
      },
      30,
      'test',
    );
    await expect(p).rejects.toThrow();
    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(true);
    expect(wasAbortedAfterTimeout).toBe(true);
  });

  it('resolves cleanly when the build promise resolves before timeout', async () => {
    const out = await withTimeoutAndSignal(
      async () => 'ok',
      1000,
      'test',
    );
    expect(out).toBe('ok');
  });

  it('clears its timer on successful resolution (behavior #3; the exact handle is cleared)', async () => {
    // DIRECT check of the `finally { clearTimeout(timer) }`: the handle setTimeout
    // returned is the one passed to clearTimeout. The old test used a wall-clock
    // "50 calls < 500ms" proxy that was BOTH flaky (the async continuations can be
    // scheduled late under parallel load → false RED) AND vacuous for its stated
    // purpose — a LEAKED 30s timer never slows resolution, so it passed whether or
    // not the timer was cleared. Spy the timer globals to observe the real effect.
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const created: Array<ReturnType<typeof setTimeout>> = [];
    const cleared: unknown[] = [];
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const t = realSet(fn, ms, ...rest);
      created.push(t);
      return t;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((t: unknown) => {
      cleared.push(t);
      return realClear(t as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout;
    try {
      await withTimeoutAndSignal(async () => 'ok', 30_000, 'test');
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
    expect(created.length).toBeGreaterThanOrEqual(1); // the timeout timer was created
    expect(cleared).toContain(created[0]); // …and that exact timer was cleared on success
  });

  it('passes a fresh AbortSignal per call', async () => {
    const signals: AbortSignal[] = [];
    await withTimeoutAndSignal(
      async (s) => {
        signals.push(s);
        return 'a';
      },
      1000,
      'a',
    );
    await withTimeoutAndSignal(
      async (s) => {
        signals.push(s);
        return 'b';
      },
      1000,
      'b',
    );
    expect(signals[0]).not.toBe(signals[1]);
  });
});
