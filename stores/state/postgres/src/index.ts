/**
 * PostgreSQL StateStore adapter — the durable sibling of
 * @tenet/stores-state-redis for deployments that already run Postgres
 * and don't want a second stateful service.
 *
 * Design notes:
 *   - Injected client (same pattern as @tenet/stores-vector-pgvector):
 *     wire `pg`, `postgres.js`, Neon serverless, or any pool exposing
 *     query(sql, params). No driver hard dep.
 *   - Single table, lazy-expiry: expired rows are treated as missing on
 *     read and overwritten on write. Run sweepExpired() from a cron for
 *     space reclamation; correctness never depends on the sweep.
 *   - incr() is atomic via INSERT ... ON CONFLICT DO UPDATE in one
 *     round-trip — safe across replicas pointed at the same primary.
 *
 * Table DDL (run once, or call ensureTable()):
 *
 *   CREATE TABLE IF NOT EXISTS tenet_state (
 *     key        text PRIMARY KEY,
 *     value      text NOT NULL,
 *     expires_at timestamptz
 *   );
 */

/** Minimal Postgres client contract — matches pg.Pool / postgres.js shim. */
export interface PostgresLikeClient {
  query(
    sql: string,
    params: ReadonlyArray<unknown>,
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
}

/** Re-declared locally to avoid a hard dep on @tenet/stores-state-redis. */
export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string, opts?: { ttlSec?: number }): Promise<number>;
}

export interface PostgresStateStoreOptions {
  /** Table name. Validated against ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$. Default 'tenet_state'. */
  table?: string;
  /** Key prefix applied to every operation (multi-tenant separation). */
  prefix?: string;
  /** Clock injection for tests. Default Date.now. */
  now?: () => number;
}

const TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export class PostgresStateStore implements StateStore {
  private readonly table: string;
  private readonly prefix: string;
  private readonly now: () => number;

  constructor(
    private readonly client: PostgresLikeClient,
    opts: PostgresStateStoreOptions = {},
  ) {
    const table = opts.table ?? 'tenet_state';
    // SECURITY: table name is interpolated into SQL (identifiers can't be
    // parameterized). Strict allow-list prevents injection via config.
    if (!TABLE_RE.test(table)) {
      throw new Error(`PostgresStateStore: invalid table name '${table}'`);
    }
    this.table = table;
    this.prefix = opts.prefix ?? '';
    this.now = opts.now ?? (() => Date.now());
  }

  /** Create the backing table if it doesn't exist. Idempotent. */
  async ensureTable(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        key        text PRIMARY KEY,
        value      text NOT NULL,
        expires_at timestamptz
      )`,
      [],
    );
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private expiryIso(ttlSec: number): string {
    return new Date(this.now() + ttlSec * 1000).toISOString();
  }

  async get(key: string): Promise<string | null> {
    const { rows } = await this.client.query(
      `SELECT value FROM ${this.table}
       WHERE key = $1 AND (expires_at IS NULL OR expires_at > $2)`,
      [this.k(key), this.nowIso()],
    );
    const v = rows[0]?.['value'];
    return typeof v === 'string' ? v : null;
  }

  async set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void> {
    const expires = opts?.ttlSec !== undefined ? this.expiryIso(opts.ttlSec) : null;
    await this.client.query(
      `INSERT INTO ${this.table} (key, value, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, expires_at = $3`,
      [this.k(key), value, expires],
    );
  }

  async del(key: string): Promise<void> {
    await this.client.query(
      `DELETE FROM ${this.table} WHERE key = $1`,
      [this.k(key)],
    );
  }

  /**
   * Atomic increment in one round-trip. An expired row restarts the
   * counter at 1 (matches Redis INCR-after-expiry semantics). TTL is
   * applied only when the row is created or was expired — an active
   * counter's expiry is not extended (matches the Redis-adapter
   * behaviour of INCR + EXPIRE NX).
   */
  async incr(key: string, opts?: { ttlSec?: number }): Promise<number> {
    const expires = opts?.ttlSec !== undefined ? this.expiryIso(opts.ttlSec) : null;
    const { rows } = await this.client.query(
      `INSERT INTO ${this.table} (key, value, expires_at)
       VALUES ($1, '1', $3)
       ON CONFLICT (key) DO UPDATE SET
         value = CASE
           WHEN ${this.table}.expires_at IS NOT NULL AND ${this.table}.expires_at <= $2
             THEN '1'
           ELSE (${this.table}.value::bigint + 1)::text
         END,
         expires_at = CASE
           WHEN ${this.table}.expires_at IS NOT NULL AND ${this.table}.expires_at <= $2
             THEN $3
           ELSE ${this.table}.expires_at
         END
       RETURNING value`,
      [this.k(key), this.nowIso(), expires],
    );
    const v = rows[0]?.['value'];
    const n = typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
    if (!Number.isInteger(n)) {
      throw new Error(`PostgresStateStore.incr: non-integer counter for key '${key}'`);
    }
    return n;
  }

  /** Delete expired rows. Returns count removed. Run from cron; optional. */
  async sweepExpired(): Promise<number> {
    const { rows } = await this.client.query(
      `WITH gone AS (
         DELETE FROM ${this.table}
         WHERE expires_at IS NOT NULL AND expires_at <= $1
         RETURNING 1
       ) SELECT count(*)::text AS n FROM gone`,
      [this.nowIso()],
    );
    const v = rows[0]?.['n'];
    return typeof v === 'string' ? Number.parseInt(v, 10) : 0;
  }
}

export const VERSION = '0.0.0';
