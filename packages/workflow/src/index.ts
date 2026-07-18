/**
 * Deterministic workflow DAG — closes the orchestration gap vs
 * LangGraph + Mastra.
 *
 * Design altitude — what we ship:
 *   - sequential(steps) — left-to-right pipe, type-safe input → output
 *   - parallel(steps)   — fan-out, results in input order, all-or-nothing
 *   - branch(predicate, ifTrue, ifFalse) — type-safe conditional
 *   - retry(step, policy) — exponential backoff with capped attempts
 *   - withTimeout(step, ms) — wall-clock with AbortSignal cooperation
 *   - emitTrace() — per-step OTel-friendly span shape
 *
 * Design altitude — what we DON'T ship:
 *   - Persistence / resumability (operator picks: Redis / DB / file)
 *   - DSL / YAML config (the steps are TypeScript functions; type
 *     safety beats YAML)
 *   - Visual editor (out of scope for v0.0.0)
 *
 * Every step is a pure(-ish) async function. The framework guarantees
 * AbortSignal propagation through every primitive — no zombie HTTP
 * after a withTimeout fires. Trace events emit at each boundary.
 */

// ── Core step type ────────────────────────────────────────────────────

export interface StepContext {
  /** Cooperative cancellation. Every step MUST honor this. */
  signal: AbortSignal;
  /** Per-run id; appears on every trace event. */
  runId: string;
  /** Per-step id; helps callers correlate inputs to outputs. */
  stepId: string;
  /** Optional trace sink. */
  trace?: (event: TraceEvent) => void;
}

export type Step<I, O> = (input: I, ctx: StepContext) => Promise<O>;

// ── Trace events ──────────────────────────────────────────────────────

export type TraceEvent =
  | { kind: 'step.start'; runId: string; stepId: string; tMs: number }
  | { kind: 'step.end'; runId: string; stepId: string; tMs: number; durationMs: number }
  | { kind: 'step.error'; runId: string; stepId: string; tMs: number; error: string }
  | { kind: 'step.retry'; runId: string; stepId: string; tMs: number; attempt: number };

// ── Errors ────────────────────────────────────────────────────────────

export class WorkflowError extends Error {
  constructor(
    public readonly code: 'timeout' | 'retry_exhausted' | 'parallel_failed' | 'aborted',
    public readonly stepId: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// ── Sequential ────────────────────────────────────────────────────────

/**
 * Left-to-right pipe. Each step's output becomes the next step's input.
 * The return type chains through the tuple.
 */
export function sequential<I, A>(s1: Step<I, A>): Step<I, A>;
export function sequential<I, A, B>(s1: Step<I, A>, s2: Step<A, B>): Step<I, B>;
export function sequential<I, A, B, C>(s1: Step<I, A>, s2: Step<A, B>, s3: Step<B, C>): Step<I, C>;
export function sequential<I, A, B, C, D>(
  s1: Step<I, A>,
  s2: Step<A, B>,
  s3: Step<B, C>,
  s4: Step<C, D>,
): Step<I, D>;
export function sequential<I, A, B, C, D, E>(
  s1: Step<I, A>,
  s2: Step<A, B>,
  s3: Step<B, C>,
  s4: Step<C, D>,
  s5: Step<D, E>,
): Step<I, E>;
export function sequential(...steps: ReadonlyArray<Step<unknown, unknown>>): Step<unknown, unknown> {
  return async (input, ctx) => {
    let current: unknown = input;
    for (let i = 0; i < steps.length; i++) {
      if (ctx.signal.aborted) throw new WorkflowError('aborted', ctx.stepId, 'sequential aborted');
      const sub: StepContext = { ...ctx, stepId: `${ctx.stepId}.${i}` };
      current = await runWithTrace(steps[i]!, current, sub);
    }
    return current;
  };
}

// ── Parallel ──────────────────────────────────────────────────────────

/**
 * All-or-nothing fan-out. Any step rejecting → all aborted → throw
 * parallel_failed (the underlying first error becomes the cause).
 */
export function parallel<I, A, B>(s1: Step<I, A>, s2: Step<I, B>): Step<I, readonly [A, B]>;
export function parallel<I, A, B, C>(s1: Step<I, A>, s2: Step<I, B>, s3: Step<I, C>): Step<I, readonly [A, B, C]>;
export function parallel<I, A, B, C, D>(
  s1: Step<I, A>, s2: Step<I, B>, s3: Step<I, C>, s4: Step<I, D>,
): Step<I, readonly [A, B, C, D]>;
export function parallel(...steps: ReadonlyArray<Step<unknown, unknown>>): Step<unknown, ReadonlyArray<unknown>> {
  return async (input, ctx) => {
    const inner = new AbortController();
    const onParentAbort = (): void => inner.abort();
    if (ctx.signal.aborted) inner.abort();
    else ctx.signal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const results = await Promise.all(
        steps.map((s, i) =>
          runWithTrace(s, input, { ...ctx, stepId: `${ctx.stepId}.${i}`, signal: inner.signal }).catch((e) => {
            inner.abort();
            throw e;
          }),
        ),
      );
      return results;
    } catch (e) {
      // CORRECTNESS 2026-06-04: distinguish parent-abort from genuine
      // child failure. If the caller's signal aborted, surface the
      // abort intent rather than wrapping it as parallel_failed.
      if (ctx.signal.aborted) {
        throw new WorkflowError('aborted', ctx.stepId, 'parallel aborted by caller');
      }
      // SECURITY 2026-06-04: don't interpolate the child error's
      // message — it may contain a leaked bearer token from an
      // upstream API error. Stash the cause; consumers inspect it.
      const err = new WorkflowError('parallel_failed', ctx.stepId, 'parallel step failed');
      (err as Error & { cause?: unknown }).cause = e;
      throw err;
    } finally {
      ctx.signal.removeEventListener('abort', onParentAbort);
    }
  };
}

// ── Branch ────────────────────────────────────────────────────────────

export function branch<I, A, B>(
  predicate: (input: I) => boolean | Promise<boolean>,
  ifTrue: Step<I, A>,
  ifFalse: Step<I, B>,
): Step<I, A | B> {
  return async (input, ctx) => {
    if (ctx.signal.aborted) throw new WorkflowError('aborted', ctx.stepId, 'branch aborted');
    const go = await predicate(input);
    if (go) return runWithTrace(ifTrue, input, ctx);
    return runWithTrace(ifFalse, input, ctx);
  };
}

// ── Retry ─────────────────────────────────────────────────────────────

export interface RetryPolicy {
  maxAttempts: number;
  /** Initial delay in ms. Default 100. */
  initialDelayMs?: number;
  /** Multiplier per attempt. Default 2 (exponential). */
  backoffFactor?: number;
  /** Cap delay. Default 30_000. */
  maxDelayMs?: number;
  /** Filter — return true to retry, false to surface. Default: any throw retries. */
  shouldRetry?: (err: unknown) => boolean;
}

export function retry<I, O>(step: Step<I, O>, policy: RetryPolicy): Step<I, O> {
  if (policy.maxAttempts <= 0) throw new Error('retry: maxAttempts must be > 0');
  return async (input, ctx) => {
    const initial = policy.initialDelayMs ?? 100;
    const factor = policy.backoffFactor ?? 2;
    const cap = policy.maxDelayMs ?? 30_000;
    const filter = policy.shouldRetry ?? ((): boolean => true);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      try {
        return await step(input, ctx);
      } catch (e) {
        lastErr = e;
        if (attempt === policy.maxAttempts || !filter(e)) break;
        ctx.trace?.({ kind: 'step.retry', runId: ctx.runId, stepId: ctx.stepId, tMs: Date.now(), attempt });
        const delay = Math.min(cap, initial * factor ** (attempt - 1));
        // CORRECTNESS 2026-06-04: remove the abort listener when the
        // timer resolves normally — previously the listener stayed on
        // ctx.signal across every retry, leaking N listeners per call.
        await new Promise<void>((resolve, reject) => {
          let t: ReturnType<typeof setTimeout> | undefined;
          const onAbort = (): void => {
            if (t) clearTimeout(t);
            ctx.signal.removeEventListener('abort', onAbort);
            reject(new WorkflowError('aborted', ctx.stepId, 'retry aborted'));
          };
          t = setTimeout(() => {
            ctx.signal.removeEventListener('abort', onAbort);
            resolve();
          }, delay);
          ctx.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
    throw new WorkflowError('retry_exhausted', ctx.stepId, `${policy.maxAttempts} attempts: ${(lastErr as Error).message}`);
  };
}

// ── Timeout ───────────────────────────────────────────────────────────

export function withTimeout<I, O>(step: Step<I, O>, timeoutMs: number): Step<I, O> {
  return async (input, ctx) => {
    const ctrl = new AbortController();
    const composed = AbortSignal.any([ctx.signal, ctrl.signal]);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await step(input, { ...ctx, signal: composed });
    } catch (e) {
      if (ctrl.signal.aborted) {
        throw new WorkflowError('timeout', ctx.stepId, `wall-clock ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Trace runner ──────────────────────────────────────────────────────

async function runWithTrace<I, O>(step: Step<I, O>, input: I, ctx: StepContext): Promise<O> {
  const start = Date.now();
  ctx.trace?.({ kind: 'step.start', runId: ctx.runId, stepId: ctx.stepId, tMs: start });
  try {
    const out = await step(input, ctx);
    ctx.trace?.({
      kind: 'step.end',
      runId: ctx.runId,
      stepId: ctx.stepId,
      tMs: Date.now(),
      durationMs: Date.now() - start,
    });
    return out;
  } catch (e) {
    ctx.trace?.({
      kind: 'step.error',
      runId: ctx.runId,
      stepId: ctx.stepId,
      tMs: Date.now(),
      error: (e as Error).message,
    });
    throw e;
  }
}

// ── Top-level runner ──────────────────────────────────────────────────

export async function runWorkflow<I, O>(
  step: Step<I, O>,
  input: I,
  opts: { runId: string; signal?: AbortSignal; trace?: (e: TraceEvent) => void } = { runId: 'run' },
): Promise<O> {
  const ctx: StepContext = {
    signal: opts.signal ?? new AbortController().signal,
    runId: opts.runId,
    stepId: 'root',
    ...(opts.trace !== undefined ? { trace: opts.trace } : {}),
  };
  return runWithTrace(step, input, ctx);
}

export const VERSION = '0.0.0';
