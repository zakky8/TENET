import {
  mintToken,
  waitUntilReadable,
  ReadinessTimeoutError,
  InMemoryReadinessChecker,
  resolveConflict,
  type ReadinessChecker,
  type IdempotencyToken,
} from './consistency.js';

describe('mintToken', () => {
  it('same (tenantId, content) → same id', () => {
    const a = mintToken('t1', 'hello', () => 100);
    const b = mintToken('t1', 'hello', () => 200);
    expect(a.id).toBe(b.id);
  });

  it('different content → different id', () => {
    const a = mintToken('t1', 'a', () => 0);
    const b = mintToken('t1', 'b', () => 0);
    expect(a.id).not.toBe(b.id);
  });

  it('different tenant → different id', () => {
    const a = mintToken('t1', 'x', () => 0);
    const b = mintToken('t2', 'x', () => 0);
    expect(a.id).not.toBe(b.id);
  });

  it('mintedAtMs comes from injected clock', () => {
    expect(mintToken('t', 'c', () => 12345).mintedAtMs).toBe(12345);
  });
});

describe('waitUntilReadable', () => {
  it('returns immediately when already readable', async () => {
    const tok: IdempotencyToken = { id: 'x', mintedAtMs: 0 };
    const checker: ReadinessChecker = { async isReadable() { return true; } };
    await expect(waitUntilReadable(checker, tok)).resolves.toBeUndefined();
  });

  it('polls until readable then returns', async () => {
    let calls = 0;
    const checker: ReadinessChecker = {
      async isReadable() { calls++; return calls >= 3; },
    };
    const tok: IdempotencyToken = { id: 'x', mintedAtMs: 0 };
    await waitUntilReadable(checker, tok, { initialIntervalMs: 5 });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('throws ReadinessTimeoutError on ceiling', async () => {
    const checker: ReadinessChecker = { async isReadable() { return false; } };
    const tok: IdempotencyToken = { id: 'x', mintedAtMs: 0 };
    await expect(
      waitUntilReadable(checker, tok, { timeoutMs: 30, initialIntervalMs: 10 }),
    ).rejects.toBeInstanceOf(ReadinessTimeoutError);
  });

  it('respects abort signal', async () => {
    const checker: ReadinessChecker = { async isReadable() { return false; } };
    const tok: IdempotencyToken = { id: 'x', mintedAtMs: 0 };
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    await expect(
      waitUntilReadable(checker, tok, { timeoutMs: 5_000, initialIntervalMs: 5, signal: ctrl.signal }),
    ).rejects.toThrow(/aborted/);
  });
});

describe('InMemoryReadinessChecker', () => {
  it('returns true after mark()', async () => {
    const c = new InMemoryReadinessChecker();
    const tok: IdempotencyToken = { id: 'x', mintedAtMs: 0 };
    expect(await c.isReadable(tok)).toBe(false);
    c.mark(tok);
    expect(await c.isReadable(tok)).toBe(true);
  });
});

describe('resolveConflict', () => {
  it('no existing → candidate', () => {
    expect(resolveConflict(undefined, 'a', 'last_write_wins')).toBe('a');
  });
  it('last_write_wins → candidate', () => {
    expect(resolveConflict('old', 'new', 'last_write_wins')).toBe('new');
  });
  it('first_write_wins → null (drop)', () => {
    expect(resolveConflict('old', 'new', 'first_write_wins')).toBeNull();
  });
  it('merge uses provided merger', () => {
    expect(resolveConflict('a', 'b', 'merge', (x, y) => x + y)).toBe('ab');
  });
  it('merge without merger throws', () => {
    expect(() => resolveConflict('a', 'b', 'merge')).toThrow();
  });
});
