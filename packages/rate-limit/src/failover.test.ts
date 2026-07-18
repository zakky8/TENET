import { failover } from './failover.js';
import { retryWithBackoff } from './retryWithBackoff.js';

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}
function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

describe('failover — happy path', () => {
  it('returns the first provider that succeeds; later providers are not called', async () => {
    let bCalls = 0;
    const out = await failover([
      async () => 'a',
      async () => { bCalls++; return 'b'; },
    ]);
    expect(out).toBe('a');
    expect(bCalls).toBe(0);
  });

  it('fails over on a TRANSIENT error (503) to the next provider', async () => {
    const overs: number[] = [];
    const out = await failover(
      [
        async () => { throw httpError(503); },
        async () => 'recovered',
      ],
      { onFailover: ({ fromIndex }) => overs.push(fromIndex) },
    );
    expect(out).toBe('recovered');
    expect(overs).toEqual([0]); // moved on from provider 0
  });
});

describe('failover — FAIL CLOSED (never fail over on a fatal class)', () => {
  it('does NOT fail over on an AbortError — a cancelled turn stays cancelled', async () => {
    let bCalls = 0;
    await expect(
      failover([
        async () => { throw abortError(); },
        async () => { bCalls++; return 'b'; },
      ]),
    ).rejects.toThrow(/aborted/);
    expect(bCalls).toBe(0); // second provider never tried
  });

  it('does NOT fail over on a 4xx client error (it fails identically everywhere)', async () => {
    let bCalls = 0;
    await expect(
      failover([
        async () => { throw httpError(401); },
        async () => { bCalls++; return 'b'; },
      ]),
    ).rejects.toThrow(/HTTP 401/);
    expect(bCalls).toBe(0);
  });
});

describe('failover — exhaustion + options', () => {
  it('throws the LAST error when every provider fails over', async () => {
    let calls = 0;
    await expect(
      failover([
        async () => { calls++; throw httpError(503); },
        async () => { calls++; throw httpError(500); },
      ]),
    ).rejects.toThrow(/HTTP 500/); // the last provider's error
    expect(calls).toBe(2);
  });

  it('a custom shouldFailover overrides the taxonomy default', async () => {
    // Force fail-over on a normally-fatal 400.
    const out = await failover(
      [async () => { throw httpError(400); }, async () => 'forced'],
      { shouldFailover: () => true },
    );
    expect(out).toBe('forced');
  });

  it('throws when given no providers', async () => {
    await expect(failover([])).rejects.toThrow(/at least one provider/);
  });

  it('threads the signal to each provider callable', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    await failover([async (signal) => { seen = signal; return 'x'; }], { signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });
});

describe('failover — composes with retryWithBackoff', () => {
  it('retries a transient provider first, then fails over once its retries exhaust', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number): Promise<void> => { delays.push(ms); };
    let aAttempts = 0;
    const providerA = (): Promise<string> =>
      retryWithBackoff(async () => { aAttempts++; throw httpError(503); }, { sleep, maxAttempts: 3, random: () => 0 });
    const providerB = async (): Promise<string> => 'b';

    const out = await failover([providerA, providerB]);
    expect(out).toBe('b');
    expect(aAttempts).toBe(3);         // A exhausted its own retries first
    expect(delays).toEqual([100, 200]); // A backed off twice before giving up
  });
});
