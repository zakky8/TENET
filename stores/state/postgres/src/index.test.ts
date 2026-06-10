import { PostgresStateStore, type PostgresLikeClient } from './index.js';

/**
 * In-memory fake that emulates the exact SQL shapes the store issues.
 * Not a SQL engine — it pattern-matches the store's own statements so
 * the adapter logic (expiry comparisons, conflict-upsert, counter
 * semantics) is exercised without a live Postgres.
 */
function fakePg(now: () => number): PostgresLikeClient & { dump(): Map<string, { value: string; expiresAt: number | null }> } {
  const rows = new Map<string, { value: string; expiresAt: number | null }>();
  const ms = (iso: unknown): number | null =>
    iso === null || iso === undefined ? null : Date.parse(String(iso));
  return {
    dump: () => rows,
    async query(sql, params) {
      if (sql.startsWith('CREATE TABLE')) return { rows: [] };
      if (sql.startsWith('SELECT value')) {
        const key = String(params[0]);
        const nowMs = ms(params[1])!;
        const r = rows.get(key);
        if (!r) return { rows: [] };
        if (r.expiresAt !== null && r.expiresAt <= nowMs) return { rows: [] };
        return { rows: [{ value: r.value }] };
      }
      if (sql.startsWith('INSERT INTO') && sql.includes("VALUES ($1, '1', $3)")) {
        // incr path
        const key = String(params[0]);
        const nowMs = ms(params[1])!;
        const exp = ms(params[2]);
        const r = rows.get(key);
        if (!r) {
          rows.set(key, { value: '1', expiresAt: exp });
          return { rows: [{ value: '1' }] };
        }
        if (r.expiresAt !== null && r.expiresAt <= nowMs) {
          rows.set(key, { value: '1', expiresAt: exp });
          return { rows: [{ value: '1' }] };
        }
        const next = String(BigInt(r.value) + 1n);
        rows.set(key, { value: next, expiresAt: r.expiresAt });
        return { rows: [{ value: next }] };
      }
      if (sql.startsWith('INSERT INTO')) {
        // set path
        const key = String(params[0]);
        rows.set(key, { value: String(params[1]), expiresAt: ms(params[2]) });
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM') || sql.includes('DELETE FROM')) {
        if (sql.startsWith('WITH gone')) {
          const nowMs = ms(params[0])!;
          let n = 0;
          for (const [k, r] of rows) {
            if (r.expiresAt !== null && r.expiresAt <= nowMs) { rows.delete(k); n++; }
          }
          return { rows: [{ n: String(n) }] };
        }
        rows.delete(String(params[0]));
        return { rows: [] };
      }
      if (sql.startsWith('WITH gone')) {
        const nowMs = ms(params[0])!;
        let n = 0;
        for (const [k, r] of rows) {
          if (r.expiresAt !== null && r.expiresAt <= nowMs) { rows.delete(k); n++; }
        }
        return { rows: [{ n: String(n) }] };
      }
      throw new Error(`fakePg: unrecognized SQL: ${sql.slice(0, 60)}`);
    },
  };
}

describe('PostgresStateStore', () => {
  let clock = 1_000_000;
  const now = (): number => clock;

  beforeEach(() => { clock = 1_000_000; });

  it('rejects SQL-injectable table names', () => {
    const pg = fakePg(now);
    expect(() => new PostgresStateStore(pg, { table: 'x; DROP TABLE users;--' })).toThrow(/invalid table/);
    expect(() => new PostgresStateStore(pg, { table: '1starts_with_digit' })).toThrow(/invalid table/);
    expect(() => new PostgresStateStore(pg, { table: 'valid_name' })).not.toThrow();
  });

  it('set/get round-trip', async () => {
    const store = new PostgresStateStore(fakePg(now), { now });
    await store.set('a', 'hello');
    expect(await store.get('a')).toBe('hello');
    expect(await store.get('missing')).toBeNull();
  });

  it('TTL expiry — value disappears after ttlSec', async () => {
    const store = new PostgresStateStore(fakePg(now), { now });
    await store.set('a', 'v', { ttlSec: 10 });
    expect(await store.get('a')).toBe('v');
    clock += 11_000;
    expect(await store.get('a')).toBeNull();
  });

  it('del removes', async () => {
    const store = new PostgresStateStore(fakePg(now), { now });
    await store.set('a', 'v');
    await store.del('a');
    expect(await store.get('a')).toBeNull();
  });

  it('incr counts atomically and restarts after expiry', async () => {
    const store = new PostgresStateStore(fakePg(now), { now });
    expect(await store.incr('c', { ttlSec: 60 })).toBe(1);
    expect(await store.incr('c', { ttlSec: 60 })).toBe(2);
    expect(await store.incr('c', { ttlSec: 60 })).toBe(3);
    clock += 61_000;
    expect(await store.incr('c', { ttlSec: 60 })).toBe(1); // expired → restart
  });

  it('prefix isolates tenants', async () => {
    const pg = fakePg(now);
    const a = new PostgresStateStore(pg, { prefix: 'tenantA:', now });
    const b = new PostgresStateStore(pg, { prefix: 'tenantB:', now });
    await a.set('k', 'from-a');
    await b.set('k', 'from-b');
    expect(await a.get('k')).toBe('from-a');
    expect(await b.get('k')).toBe('from-b');
  });

  it('sweepExpired removes only expired rows', async () => {
    const pg = fakePg(now);
    const store = new PostgresStateStore(pg, { now });
    await store.set('keep', 'v');
    await store.set('keep-ttl', 'v', { ttlSec: 100 });
    await store.set('gone', 'v', { ttlSec: 5 });
    clock += 6_000;
    expect(await store.sweepExpired()).toBe(1);
    expect(await store.get('keep')).toBe('v');
    expect(await store.get('keep-ttl')).toBe('v');
    expect(await store.get('gone')).toBeNull();
  });

  it('ensureTable issues CREATE TABLE IF NOT EXISTS', async () => {
    const pg = fakePg(now);
    const store = new PostgresStateStore(pg, { now });
    await expect(store.ensureTable()).resolves.toBeUndefined();
  });
});
