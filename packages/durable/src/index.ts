/**
 * @tenet/durable — step-level durable execution.
 *
 * The June-2026 bar for agent frameworks is not "can checkpoint" but
 * "deterministic replay, survives deploys, resumable streams" (every
 * leader shipped one: LangGraph checkpointing, Pydantic-AI×Temporal,
 * Vercel WDK "use step", Mastra suspend/resume). TypeScript is
 * underserved here — this package closes the gap without requiring a
 * workflow cluster.
 *
 * Model:
 *   - A *run* is an async function re-executed from the top on every
 *     invocation. Completed steps are memoized in a journal, so replay
 *     is cheap and deterministic: code that already ran returns its
 *     recorded result without executing again.
 *   - Steps are keyed by NAME, not sequence. Names must be unique per
 *     run (suffix loop indices: `fetch:${i}`). Name-keying makes
 *     Promise.all() of steps replay-safe — arrival order doesn't
 *     matter, identity does.
 *   - ctx.interrupt() is first-class human-in-the-loop: it suspends
 *     the run until resolveInterrupt() writes a value, then replay
 *     continues past it. Suspension survives process restarts because
 *     the journal is the only state.
 *   - ctx.sleep() is a durable timer: the wake time is journaled; the
 *     scheduler that re-invokes run() is the caller's (cron, queue,
 *     setTimeout — anything).
 *
 * What this is NOT: a distributed workflow cluster. One active
 * executor per runId is assumed (enforce with a lease/lock upstream if
 * you run replicas). For Temporal-grade multi-region routing, wire
 * Temporal — this package covers the 95% case with zero infra.
 */

// ── Journal ───────────────────────────────────────────────────────────

export type EntryKind = 'step' | 'sleep' | 'interrupt';

export interface JournalEntry {
  /** Unique-per-run step name (the memoization key). */
  name: string;
  kind: EntryKind;
  status: 'ok' | 'pending';
  /**
   * status ok      → JSON-encoded result value
   * sleep pending  → JSON {"wakeAt": epochMs}
   * interrupt pending → JSON-encoded request payload (or "null")
   */
  data: string;
}

export interface JournalStore {
  load(runId: string): Promise<JournalEntry[]>;
  append(runId: string, entry: JournalEntry): Promise<void>;
  /** Replace the entry with the same name (pending → ok transitions). */
  update(runId: string, name: string, entry: JournalEntry): Promise<void>;
}

export class InMemoryJournalStore implements JournalStore {
  private readonly runs = new Map<string, JournalEntry[]>();

  async load(runId: string): Promise<JournalEntry[]> {
    return [...(this.runs.get(runId) ?? [])];
  }

  async append(runId: string, entry: JournalEntry): Promise<void> {
    const list = this.runs.get(runId) ?? [];
    list.push(entry);
    this.runs.set(runId, list);
  }

  async update(runId: string, name: string, entry: JournalEntry): Promise<void> {
    const list = this.runs.get(runId) ?? [];
    const i = list.findIndex((e) => e.name === name);
    if (i === -1) throw new Error(`journal update: no entry named '${name}' in run '${runId}'`);
    list[i] = entry;
  }
}

/** Minimal slice of @tenet/stores-state-* — re-declared to stay dep-free. */
export interface StateStoreLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void>;
}

/**
 * Journal persisted through any StateStore (Redis, Postgres, in-memory)
 * as one JSON document per run under `prefix + runId`.
 *
 * Concurrency note: load-modify-write, NOT atomic. Safe under the
 * one-executor-per-run assumption stated above; do not share a runId
 * across concurrent executors.
 */
export class StateStoreJournal implements JournalStore {
  /**
   * In-process write serialization: Promise.all() of steps appends
   * concurrently; without a chain, load-modify-write loses entries.
   * (Cross-process races remain out of scope — one executor per run.)
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: StateStoreLike,
    private readonly opts: { prefix?: string; ttlSec?: number } = {},
  ) {}

  private key(runId: string): string {
    return (this.opts.prefix ?? 'tenet:journal:') + runId;
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const result = this.chain.then(op, op);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async load(runId: string): Promise<JournalEntry[]> {
    const raw = await this.store.get(this.key(runId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`journal for '${runId}' is not an array`);
    return parsed as JournalEntry[];
  }

  private async save(runId: string, entries: JournalEntry[]): Promise<void> {
    const opts = this.opts.ttlSec !== undefined ? { ttlSec: this.opts.ttlSec } : undefined;
    await this.store.set(this.key(runId), JSON.stringify(entries), opts);
  }

  async append(runId: string, entry: JournalEntry): Promise<void> {
    return this.serialize(async () => {
      const entries = await this.load(runId);
      entries.push(entry);
      await this.save(runId, entries);
    });
  }

  async update(runId: string, name: string, entry: JournalEntry): Promise<void> {
    return this.serialize(async () => {
      const entries = await this.load(runId);
      const i = entries.findIndex((e) => e.name === name);
      if (i === -1) throw new Error(`journal update: no entry named '${name}' in run '${runId}'`);
      entries[i] = entry;
      await this.save(runId, entries);
    });
  }
}

// ── Errors & control flow ─────────────────────────────────────────────

/**
 * Thrown internally to unwind the run function at a suspension point.
 * Callers never see it — DurableRunner catches it and returns a
 * 'suspended' RunResult. If you see this escape, a step swallowed and
 * re-threw foreign exceptions; rethrow RunSuspended unchanged.
 */
export class RunSuspended extends Error {
  constructor(
    readonly runId: string,
    readonly reason: 'interrupt' | 'sleep',
    readonly stepName: string,
    readonly payload?: unknown,
  ) {
    super(`run '${runId}' suspended at ${reason} '${stepName}'`);
    this.name = 'RunSuspended';
  }
}

/** Replay drift: same step name reused with a different kind. */
export class NondeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NondeterminismError';
  }
}

// ── Runner ────────────────────────────────────────────────────────────

export interface DurableCtx {
  readonly runId: string;
  /**
   * Execute-once step. On replay, returns the journaled result without
   * running fn. Result must be JSON-serializable. Names unique per run.
   */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  /**
   * Durable timer. Journals the wake time and suspends; when run() is
   * invoked again at/after wakeAt, replay passes through. The caller
   * owns re-invocation scheduling.
   */
  sleep(name: string, ms: number): Promise<void>;
  /**
   * Human-in-the-loop suspension. Suspends until resolveInterrupt()
   * supplies a value, which becomes the return on the resumed replay.
   * Compose with @tenet/governance: when the ApprovalGate says
   * require_approval, call ctx.interrupt with the approval request as
   * payload and resolve it from your approval surface.
   */
  interrupt<T>(name: string, payload?: unknown): Promise<T>;
}

export type RunResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'suspended'; reason: 'interrupt' | 'sleep'; stepName: string; payload?: unknown }
  | { status: 'failed'; error: string };

export interface PendingInterrupt {
  name: string;
  payload: unknown;
}

export interface DurableRunnerOptions {
  /** Clock injection for tests / determinism. Default Date.now. */
  now?: () => number;
}

export class DurableRunner {
  private readonly now: () => number;

  constructor(
    private readonly journal: JournalStore,
    opts: DurableRunnerOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Execute (or resume — same call) a durable run. Re-invoke after a
   * suspension to continue; completed steps replay from the journal.
   */
  async run<T>(runId: string, fn: (ctx: DurableCtx) => Promise<T>): Promise<RunResult<T>> {
    if (!runId) throw new Error('DurableRunner.run: runId required');
    const entries = await this.journal.load(runId);
    const byName = new Map<string, JournalEntry>();
    for (const e of entries) byName.set(e.name, e);
    const seenThisReplay = new Set<string>();
    const journal = this.journal;
    const now = this.now;

    const guard = (name: string, kind: EntryKind): JournalEntry | undefined => {
      if (seenThisReplay.has(name)) {
        throw new NondeterminismError(
          `step name '${name}' used twice in run '${runId}' — names must be unique per run (suffix loop indices)`,
        );
      }
      seenThisReplay.add(name);
      const existing = byName.get(name);
      if (existing !== undefined && existing.kind !== kind) {
        throw new NondeterminismError(
          `replay drift in run '${runId}': '${name}' was journaled as ${existing.kind}, code now calls ${kind}`,
        );
      }
      return existing;
    };

    const ctx: DurableCtx = {
      runId,
      async step<S>(name: string, stepFn: () => Promise<S> | S): Promise<S> {
        const existing = guard(name, 'step');
        if (existing?.status === 'ok') return JSON.parse(existing.data) as S;
        const value = await stepFn();
        const entry: JournalEntry = { name, kind: 'step', status: 'ok', data: JSON.stringify(value ?? null) };
        await journal.append(runId, entry);
        byName.set(name, entry);
        return value;
      },

      async sleep(name: string, ms: number): Promise<void> {
        if (ms < 0) throw new Error('sleep: ms must be >= 0');
        const existing = guard(name, 'sleep');
        if (existing?.status === 'ok') return;
        if (existing?.status === 'pending') {
          const { wakeAt } = JSON.parse(existing.data) as { wakeAt: number };
          if (now() >= wakeAt) {
            const done: JournalEntry = { name, kind: 'sleep', status: 'ok', data: 'null' };
            await journal.update(runId, name, done);
            byName.set(name, done);
            return;
          }
          throw new RunSuspended(runId, 'sleep', name, { wakeAt });
        }
        const wakeAt = now() + ms;
        const entry: JournalEntry = { name, kind: 'sleep', status: 'pending', data: JSON.stringify({ wakeAt }) };
        await journal.append(runId, entry);
        byName.set(name, entry);
        throw new RunSuspended(runId, 'sleep', name, { wakeAt });
      },

      async interrupt<S>(name: string, payload?: unknown): Promise<S> {
        const existing = guard(name, 'interrupt');
        if (existing?.status === 'ok') return JSON.parse(existing.data) as S;
        if (existing?.status === 'pending') {
          throw new RunSuspended(runId, 'interrupt', name, JSON.parse(existing.data));
        }
        const entry: JournalEntry = {
          name, kind: 'interrupt', status: 'pending', data: JSON.stringify(payload ?? null),
        };
        await journal.append(runId, entry);
        byName.set(name, entry);
        throw new RunSuspended(runId, 'interrupt', name, payload);
      },
    };

    try {
      const value = await fn(ctx);
      return { status: 'completed', value };
    } catch (err) {
      if (err instanceof RunSuspended) {
        const result: RunResult<T> = {
          status: 'suspended', reason: err.reason, stepName: err.stepName,
        };
        if (err.payload !== undefined) (result as { payload?: unknown }).payload = err.payload;
        return result;
      }
      if (err instanceof NondeterminismError) throw err;
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Supply the value for a pending interrupt; then re-invoke run(). */
  async resolveInterrupt(runId: string, name: string, value: unknown): Promise<void> {
    const entries = await this.journal.load(runId);
    const existing = entries.find((e) => e.name === name);
    if (existing === undefined) {
      throw new Error(`resolveInterrupt: no interrupt named '${name}' in run '${runId}'`);
    }
    if (existing.kind !== 'interrupt') {
      throw new Error(`resolveInterrupt: '${name}' is a ${existing.kind}, not an interrupt`);
    }
    if (existing.status === 'ok') {
      throw new Error(`resolveInterrupt: '${name}' already resolved`);
    }
    await this.journal.update(runId, name, {
      name, kind: 'interrupt', status: 'ok', data: JSON.stringify(value ?? null),
    });
  }

  /** Pending interrupts for a run — drive your approval UI from this. */
  async pendingInterrupts(runId: string): Promise<PendingInterrupt[]> {
    const entries = await this.journal.load(runId);
    return entries
      .filter((e) => e.kind === 'interrupt' && e.status === 'pending')
      .map((e) => ({ name: e.name, payload: JSON.parse(e.data) as unknown }));
  }
}

export const VERSION = '0.0.0';
