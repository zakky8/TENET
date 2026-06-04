import { InMemoryStateStore, RedisStateStore, type RedisLikeClient } from './index.js';

describe('InMemoryStateStore — basic CRUD', () => {
  it('get returns null when key is absent', async () => {
    const s = new InMemoryStateStore();
    expect(await s.get('missing')).toBeNull();
  });

  it('set + get round-trips', async () => {
    const s = new InMemoryStateStore();
    await s.set('k', 'v');
    expect(await s.get('k')).toBe('v');
  });

  it('del removes a key', async () => {
    const s = new InMemoryStateStore();
    await s.set('k', 'v');
    await s.del('k');
    expect(await s.get('k')).toBeNull();
  });
});

describe('InMemoryStateStore — TTL', () => {
  it('expires after ttlSec elapses', async () => {
    let t = 1_000_000;
    const s = new InMemoryStateStore({ now: () => t });
    await s.set('k', 'v', { ttlSec: 10 });
    expect(await s.get('k')).toBe('v');
    t += 9_999;
    expect(await s.get('k')).toBe('v');
    t += 2;
    expect(await s.get('k')).toBeNull();
  });

  it('set without ttl keeps the value indefinitely', async () => {
    let t = 0;
    const s = new InMemoryStateStore({ now: () => t });
    await s.set('k', 'v');
    t += 365 * 24 * 3600 * 1000;
    expect(await s.get('k')).toBe('v');
  });
});

describe('InMemoryStateStore — incr', () => {
  it('starts at 1 for a new key', async () => {
    const s = new InMemoryStateStore();
    expect(await s.incr('counter')).toBe(1);
  });

  it('increments existing numeric value', async () => {
    const s = new InMemoryStateStore();
    await s.set('counter', '5');
    expect(await s.incr('counter')).toBe(6);
  });

  it('throws when existing value is non-numeric', async () => {
    const s = new InMemoryStateStore();
    await s.set('counter', 'oops');
    await expect(s.incr('counter')).rejects.toThrow(/not numeric/);
  });

  it('applies ttl to a newly-created counter', async () => {
    let t = 1_000_000;
    const s = new InMemoryStateStore({ now: () => t });
    await s.incr('c', { ttlSec: 60 });
    t += 61_000;
    expect(await s.get('c')).toBeNull();
  });
});

describe('InMemoryStateStore — LRU eviction at maxKeys', () => {
  it('evicts the oldest entry when maxKeys exceeded', async () => {
    const s = new InMemoryStateStore({ maxKeys: 2 });
    await s.set('a', '1');
    await s.set('b', '2');
    await s.set('c', '3'); // forces eviction of 'a'
    expect(await s.get('a')).toBeNull();
    expect(await s.get('b')).toBe('2');
    expect(await s.get('c')).toBe('3');
  });

  it('does not evict when overwriting an existing key', async () => {
    const s = new InMemoryStateStore({ maxKeys: 2 });
    await s.set('a', '1');
    await s.set('b', '2');
    await s.set('a', 'updated'); // not new, no eviction
    expect(s.size()).toBe(2);
  });

  it('reading a key MRUs it (delays eviction)', async () => {
    const s = new InMemoryStateStore({ maxKeys: 2 });
    await s.set('a', '1');
    await s.set('b', '2');
    await s.get('a'); // 'a' becomes MRU
    await s.set('c', '3'); // evicts 'b' instead of 'a'
    expect(await s.get('a')).toBe('1');
    expect(await s.get('b')).toBeNull();
  });

  it('rejects maxKeys <= 0', () => {
    expect(() => new InMemoryStateStore({ maxKeys: 0 })).toThrow();
  });
});

describe('RedisStateStore — adapter delegates correctly', () => {
  function mockClient(): RedisLikeClient & {
    calls: Array<{ method: string; args: ReadonlyArray<unknown> }>;
    store: Map<string, string>;
  } {
    const calls: Array<{ method: string; args: ReadonlyArray<unknown> }> = [];
    const store = new Map<string, string>();
    return {
      calls,
      store,
      async get(key) {
        calls.push({ method: 'get', args: [key] });
        return store.get(key) ?? null;
      },
      async set(key, value, ...args) {
        calls.push({ method: 'set', args: [key, value, ...args] });
        store.set(key, value);
        return 'OK';
      },
      async del(key) {
        calls.push({ method: 'del', args: [key] });
        store.delete(key);
        return 1;
      },
      async incr(key) {
        calls.push({ method: 'incr', args: [key] });
        const next = (parseInt(store.get(key) ?? '0', 10) || 0) + 1;
        store.set(key, next.toString());
        return next;
      },
      async expire(key, ttlSec) {
        calls.push({ method: 'expire', args: [key, ttlSec] });
        return 1;
      },
    };
  }

  it('delegates get/set/del to the redis-like client', async () => {
    const c = mockClient();
    const s = new RedisStateStore(c);
    await s.set('k', 'v');
    expect(await s.get('k')).toBe('v');
    await s.del('k');
    expect(c.calls.map((x) => x.method)).toEqual(['set', 'get', 'del']);
  });

  it('uses SET ... EX <ttl> when ttlSec is provided', async () => {
    const c = mockClient();
    await new RedisStateStore(c).set('k', 'v', { ttlSec: 30 });
    expect(c.calls[0]).toEqual({ method: 'set', args: ['k', 'v', 'EX', 30] });
  });

  it('applies EXPIRE only on the first INCR (returns 1)', async () => {
    const c = mockClient();
    const s = new RedisStateStore(c);
    expect(await s.incr('c', { ttlSec: 60 })).toBe(1);
    const expireCalls1 = c.calls.filter((x) => x.method === 'expire').length;
    expect(expireCalls1).toBe(1);
    // Second incr returns 2, should NOT EXPIRE
    expect(await s.incr('c', { ttlSec: 60 })).toBe(2);
    const expireCalls2 = c.calls.filter((x) => x.method === 'expire').length;
    expect(expireCalls2).toBe(1);
  });

  it('honors prefix on all operations', async () => {
    const c = mockClient();
    const s = new RedisStateStore(c, 'app1');
    await s.set('k', 'v');
    expect(c.calls[0]?.args[0]).toBe('app1:k');
  });
});
