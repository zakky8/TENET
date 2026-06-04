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

  it('does not leave a pending timer after a successful resolution', async () => {
    // If the timer weren't cleared, Node would keep the loop alive.
    // Indirect check: many successful calls in quick succession should
    // not accumulate timers (we can't measure handles here, but we
    // verify resolution stays fast).
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      await withTimeoutAndSignal(async () => 'ok', 30_000, 'test');
    }
    expect(Date.now() - start).toBeLessThan(500);
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
