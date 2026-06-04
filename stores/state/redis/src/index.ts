/**
 * Conversation-state store: minimal key-value interface used by surfaces
 * + memory to persist short-lived state (session, idempotency, recent
 * messages window, rate-limit counters when shared across instances).
 *
 * The package ships:
 *   1. The StateStore interface — wire to any KV (Redis, Valkey,
 *      Upstash, KeyDB, Cloudflare KV, DynamoDB, etc.).
 *   2. RedisLikeClient adapter contract — matches ioredis / node-redis
 *      v5 minimal surface. Apps construct their client and inject.
 *   3. InMemoryStateStore — production-grade for single-instance
 *      deploys and tests. TTL respected. No external deps.
 */

export interface StateStore {
  /** Get value by key. Returns null if missing or expired. */
  get(key: string): Promise<string | null>;
  /** Set value with optional TTL in seconds. */
  set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void>;
  /** Delete a key. No-op if missing. */
  del(key: string): Promise<void>;
  /** Atomic increment. TTL on first set if provided. Returns new value. */
  incr(key: string, opts?: { ttlSec?: number }): Promise<number>;
}

// ── In-memory implementation ────────────────────────────────────────────

interface Entry {
  value: string;
  /** Absolute expiry ms, or undefined for no expiry. */
  expiresAt?: number;
}

export interface InMemoryStateStoreOptions {
  now?: () => number;
  /** Cap to avoid unbounded growth. LRU eviction on exceed. Default 10_000. */
  maxKeys?: number;
}

export class InMemoryStateStore implements StateStore {
  private readonly data = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(opts: InMemoryStateStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxKeys = opts.maxKeys ?? 10_000;
    if (this.maxKeys <= 0) throw new Error('maxKeys must be > 0');
  }

  async get(key: string): Promise<string | null> {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.expiresAt !== undefined && this.now() >= e.expiresAt) {
      this.data.delete(key);
      return null;
    }
    // Touch to MRU
    this.data.delete(key);
    this.data.set(key, e);
    return e.value;
  }

  async set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void> {
    if (this.data.size >= this.maxKeys && !this.data.has(key)) {
      // Evict the LRU entry (first inserted in Map iteration order).
      const oldest = this.data.keys().next().value;
      if (oldest !== undefined) this.data.delete(oldest);
    }
    const entry: Entry = { value };
    if (opts?.ttlSec !== undefined) entry.expiresAt = this.now() + opts.ttlSec * 1000;
    this.data.set(key, entry);
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async incr(key: string, opts?: { ttlSec?: number }): Promise<number> {
    const existing = await this.get(key);
    const next = existing === null ? 1 : Number.parseInt(existing, 10) + 1;
    if (Number.isNaN(next)) {
      throw new Error(`incr: existing value for ${key} is not numeric`);
    }
    await this.set(key, next.toString(), opts);
    return next;
  }

  /** Test helper. */
  size(): number {
    return this.data.size;
  }
}

// ── Redis-like adapter contract ────────────────────────────────────────

/**
 * Minimal client surface compatible with ioredis and node-redis v5.
 * Apps construct their client and pass it to RedisStateStore.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: ReadonlyArray<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSec: number): Promise<unknown>;
}

/**
 * StateStore implemented on top of a redis-like client. Uses standard
 * `SET key value EX <ttlSec>` for ttl'd set and `INCR` + `EXPIRE` for
 * the increment path.
 */
export class RedisStateStore implements StateStore {
  constructor(private readonly client: RedisLikeClient, private readonly prefix = '') {}

  private k(key: string): string {
    return this.prefix ? `${this.prefix}:${key}` : key;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.k(key));
  }

  async set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void> {
    if (opts?.ttlSec !== undefined) {
      await this.client.set(this.k(key), value, 'EX', opts.ttlSec);
    } else {
      await this.client.set(this.k(key), value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key));
  }

  async incr(key: string, opts?: { ttlSec?: number }): Promise<number> {
    const next = await this.client.incr(this.k(key));
    if (opts?.ttlSec !== undefined && next === 1) {
      await this.client.expire(this.k(key), opts.ttlSec);
    }
    return next;
  }
}

export const VERSION = '0.0.0';
