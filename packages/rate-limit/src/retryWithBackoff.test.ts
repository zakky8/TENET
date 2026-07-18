import { retryWithBackoff } from './retryWithBackoff.js';

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}
function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** A sleep double that records the delays and never actually waits. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { sleep: async (ms: number) => { delays.push(ms); }, delays };
}

// random()=>0 makes delay = base*(1 - jitter*0) = base — a deterministic MAX delay.
const noJitterRandom = (): number => 0;

describe('retryWithBackoff — happy path', () => {
  it('returns the first result without sleeping when fn succeeds', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const out = await retryWithBackoff(async () => { calls++; return 'ok'; }, { sleep });
    expect(out).toBe('ok');
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('retries a RETRYABLE error (503) then succeeds', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const out = await retryWithBackoff(async () => {
      calls++;
      if (calls === 1) throw httpError(503);
      return 'recovered';
    }, { sleep, random: noJitterRandom });
    expect(out).toBe('recovered');
    expect(calls).toBe(2);
    expect(delays).toEqual([100]); // one backoff before the 2nd attempt
  });
});

describe('retryWithBackoff — FAIL CLOSED (the point of the taxonomy default)', () => {
  it('does NOT retry an AbortError — re-thrown on the first attempt, no sleep', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      retryWithBackoff(async () => { calls++; throw abortError(); }, { sleep, maxAttempts: 5 }),
    ).rejects.toThrow(/aborted/);
    expect(calls).toBe(1); // never retried
    expect(delays).toEqual([]); // never backed off
  });

  it('does NOT retry a 4xx client error', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      retryWithBackoff(async () => { calls++; throw httpError(400); }, { sleep, maxAttempts: 5 }),
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('does NOT retry an unrecognized error (side-effect-safe default)', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      retryWithBackoff(async () => { calls++; throw new Error('who knows'); }, { sleep, maxAttempts: 5 }),
    ).rejects.toThrow(/who knows/);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });
});

describe('retryWithBackoff — exhaustion + backoff schedule', () => {
  it('exhausts on a persistent retryable error and throws the ORIGINAL error', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      retryWithBackoff(async () => { calls++; throw httpError(503); }, {
        sleep, random: noJitterRandom, maxAttempts: 3, initialDelayMs: 100, backoffFactor: 2,
      }),
    ).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(3); // all attempts used
    expect(delays).toEqual([100, 200]); // exponential; N-1 backoffs, no wait after the last
  });

  it('caps the base delay at maxDelayMs', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await retryWithBackoff(async () => { calls++; if (calls < 4) throw httpError(500); return 'ok'; }, {
      sleep, random: noJitterRandom, maxAttempts: 5, initialDelayMs: 1000, backoffFactor: 10, maxDelayMs: 2500,
    });
    // bases: 1000, 10000→cap 2500, 100000→cap 2500
    expect(delays).toEqual([1000, 2500, 2500]);
  });

  it('applies jitter: delay = base*(1 - jitter*random)', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await retryWithBackoff(async () => { calls++; if (calls === 1) throw httpError(503); return 'ok'; }, {
      sleep, random: () => 0.5, jitter: 1, initialDelayMs: 200,
    });
    expect(delays).toEqual([100]); // 200 * (1 - 1*0.5) = 100
  });
});

describe('retryWithBackoff — options + overrides', () => {
  it('a custom shouldRetry overrides the taxonomy default', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    // Force-retry a normally-fatal 400 by supplying shouldRetry.
    await expect(
      retryWithBackoff(async () => { calls++; throw httpError(400); }, {
        sleep, random: noJitterRandom, maxAttempts: 2, shouldRetry: () => true,
      }),
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(2); // retried because the custom filter said so
    expect(delays).toEqual([100]);
  });

  it('rejects maxAttempts <= 0 and jitter out of [0,1]', async () => {
    await expect(retryWithBackoff(async () => 'x', { maxAttempts: 0 })).rejects.toThrow(/maxAttempts/);
    await expect(retryWithBackoff(async () => 'x', { jitter: 1.5 })).rejects.toThrow(/jitter/);
  });

  it('an already-aborted signal makes the backoff wait reject (default sleep)', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await expect(
      retryWithBackoff(async () => { calls++; throw httpError(503); }, {
        maxAttempts: 3, signal: ac.signal, // default (real) sleep — aborted → rejects synchronously
      }),
    ).rejects.toThrow(/aborted/);
    expect(calls).toBe(1); // threw retryable once, then the aborted backoff wait rejected
  });
});
