import { TokenBucket } from './tokenBucket.js';

describe('TokenBucket — construction', () => {
  it('rejects non-positive capacity', () => {
    expect(() => new TokenBucket({ capacity: 0, refillTokensPerSec: 1 })).toThrow();
    expect(() => new TokenBucket({ capacity: -5, refillTokensPerSec: 1 })).toThrow();
  });

  it('rejects non-positive refill rate', () => {
    expect(() => new TokenBucket({ capacity: 5, refillTokensPerSec: 0 })).toThrow();
  });

  it('starts at capacity by default', () => {
    const b = new TokenBucket({ capacity: 10, refillTokensPerSec: 1 });
    expect(b.available()).toBe(10);
  });

  it('honors explicit initialTokens', () => {
    const b = new TokenBucket({ capacity: 10, refillTokensPerSec: 1, initialTokens: 3 });
    expect(b.available()).toBe(3);
  });
});

describe('TokenBucket.tryAcquire', () => {
  function fixedClock() {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  it('returns true when tokens are available', () => {
    const c = fixedClock();
    const b = new TokenBucket({ capacity: 3, refillTokensPerSec: 1, now: c.now });
    expect(b.tryAcquire(1)).toBe(true);
    expect(b.available()).toBe(2);
  });

  it('returns false when tokens are exhausted', () => {
    const c = fixedClock();
    const b = new TokenBucket({ capacity: 2, refillTokensPerSec: 1, now: c.now });
    b.tryAcquire(2);
    expect(b.tryAcquire(1)).toBe(false);
  });

  it('refills over time (1 token/sec → 1 token after 1000ms)', () => {
    const c = fixedClock();
    const b = new TokenBucket({ capacity: 5, refillTokensPerSec: 1, initialTokens: 0, now: c.now });
    expect(b.tryAcquire(1)).toBe(false);
    c.advance(1000);
    expect(b.tryAcquire(1)).toBe(true);
  });

  it('caps refill at capacity (no overflow)', () => {
    const c = fixedClock();
    const b = new TokenBucket({ capacity: 5, refillTokensPerSec: 1000, now: c.now });
    c.advance(60_000); // 60_000 tokens would be added but capacity is 5
    expect(b.available()).toBe(5);
  });
});

describe('TokenBucket.acquire — blocking variant', () => {
  it('rejects requests larger than capacity (would deadlock)', async () => {
    const b = new TokenBucket({ capacity: 5, refillTokensPerSec: 1 });
    await expect(b.acquire(6)).rejects.toThrow(/exceeds capacity/);
  });

  it('returns immediately (never sleeps) when tokens are available', async () => {
    // Deterministic: "returns immediately" MEANS the fast path took the token without
    // waiting — assert the sleep hook is never called. The old wall-clock bound
    // (`Date.now() - start < 20ms`) flaked under parallel worker load: the async
    // continuation after `await` can be scheduled >20ms later even though acquire()
    // itself never slept. Time is injectable precisely so tests don't race the clock.
    let slept = false;
    const b = new TokenBucket({
      capacity: 3,
      refillTokensPerSec: 1,
      now: () => 1_000_000,
      sleep: async () => {
        slept = true;
      },
    });
    await b.acquire(1);
    expect(slept).toBe(false); // tokens available → taken without a refill wait
  });

  it('waits for refill when out of tokens', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const b = new TokenBucket({
      capacity: 1,
      refillTokensPerSec: 1000, // 1 token / ms
      initialTokens: 0,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await b.acquire(1);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1);
  });

  it('throws AbortError when signal aborts while waiting', async () => {
    const ctrl = new AbortController();
    const b = new TokenBucket({
      capacity: 1,
      refillTokensPerSec: 0.001, // very slow refill
      initialTokens: 0,
      sleep: async () => {
        ctrl.abort(); // abort while "sleeping"
      },
    });
    await expect(b.acquire(1, ctrl.signal)).rejects.toThrow(/aborted/);
  });
});
