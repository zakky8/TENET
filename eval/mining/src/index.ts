/**
 * Eval-set auto-growth — assertion mining + embedding-based dedup.
 *
 * BENCHMARKS Dim 7 ("> 1M assertions"): can't be hand-written; must
 * be grown from production traces. Pipeline shape:
 *
 *   1. Collect (conversationTrace, outcome) tuples from telemetry
 *   2. mine() — for each trace, ask a judge model to emit assertions
 *      ("When user asks X, agent should cite Y; agent should NOT
 *      mention Z"). Pure-function shape: caller injects the judge.
 *   3. dedup() — drop near-duplicates using cosine similarity over
 *      provided embeddings. Greedy nearest-neighbour, threshold-gated.
 *   4. Emit as EvalCase compatible with @tenet/eval-harness.
 *
 * Pure functions; no I/O; no model calls. The caller wires the
 * judge LLM (or a stub for tests) and the embedder.
 */

import type { EvalCase, Assertion, AssertContext, AssertionResult } from '@tenet/eval-harness';

/** A captured production trace ready for mining. */
export interface ConversationTrace {
  id: string;
  tenantId: string;
  userTurn: string;
  agentAnswer: string;
  citedSourceIds: ReadonlyArray<string>;
  outcome: 'resolved' | 'handed_off' | 'disqualified' | 'qualified';
  capturedAtMs: number;
}

/** What the miner produces — assertions over the trace's own answer. */
export interface MinedAssertion {
  traceId: string;
  /** Stable id derived from trace + assertion text. */
  assertionId: string;
  /** Human-readable rule. */
  description: string;
  /**
   * Predicate kind. We restrict to a small alphabet so dedup is
   * tractable; richer predicates can compose multiple of these.
   */
  kind: 'must_contain' | 'must_not_contain' | 'must_cite' | 'must_not_cite';
  /** The string/id the predicate references. */
  value: string;
}

/** Injected LLM-as-judge. Pure-function shape. */
export interface AssertionMiner {
  mine(args: {
    trace: ConversationTrace;
    signal?: AbortSignal;
  }): Promise<ReadonlyArray<Omit<MinedAssertion, 'traceId' | 'assertionId'>>>;
}

/** Injected embedder. Pure-function shape. */
export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<ReadonlyArray<number>>;
}

/** Stable assertion id: trace id + first 16 chars of value, kind. */
function assertionId(traceId: string, kind: string, value: string): string {
  const safe = value.replace(/[^a-z0-9]/gi, '_').slice(0, 16);
  return `${traceId}:${kind}:${safe}`;
}

/** Mine assertions from a batch of traces. Bounded concurrency. */
export async function mineAssertions(
  traces: ReadonlyArray<ConversationTrace>,
  miner: AssertionMiner,
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<ReadonlyArray<MinedAssertion>> {
  const c = Math.max(1, opts.concurrency ?? 4);
  const out: MinedAssertion[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(c, traces.length) }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= traces.length) return;
        const trace = traces[idx]!;
        const partial = await miner.mine({
          trace,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
        for (const p of partial) {
          out.push({
            traceId: trace.id,
            assertionId: assertionId(trace.id, p.kind, p.value),
            ...p,
          });
        }
      }
    }),
  );
  return out;
}

/** Cosine similarity between two non-empty equal-length vectors. */
export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length) throw new Error(`cosine: dims differ ${a.length}/${b.length}`);
  if (a.length === 0) throw new Error('cosine: empty vector');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Greedy near-duplicate removal. For each assertion: embed → compare
 * to all kept embeddings → if max cosine >= threshold, drop. O(n²)
 * worst case; for million-scale runs the caller switches to ANN
 * (HNSW / IVF) via the same Embedder + a clustering step.
 */
export async function dedupAssertions(
  assertions: ReadonlyArray<MinedAssertion>,
  embedder: Embedder,
  opts: { threshold: number; signal?: AbortSignal } = { threshold: 0.92 },
): Promise<{ kept: ReadonlyArray<MinedAssertion>; dropped: number }> {
  if (opts.threshold <= 0 || opts.threshold > 1) {
    throw new Error(`dedup threshold must be in (0,1], got ${opts.threshold}`);
  }
  const kept: MinedAssertion[] = [];
  const keptVecs: number[][] = [];
  let dropped = 0;
  for (const a of assertions) {
    const vec = Array.from(await embedder.embed(a.description, opts.signal));
    let isDup = false;
    for (const k of keptVecs) {
      if (cosine(vec, k) >= opts.threshold) {
        isDup = true;
        break;
      }
    }
    if (isDup) {
      dropped++;
    } else {
      kept.push(a);
      keptVecs.push(vec);
    }
  }
  return { kept, dropped };
}

// ── EvalCase emission ─────────────────────────────────────────────────

function predicateFor(a: MinedAssertion): Assertion {
  switch (a.kind) {
    case 'must_contain':
      return {
        id: a.assertionId,
        async check({ output }: AssertContext): Promise<AssertionResult> {
          return String(output).includes(a.value)
            ? { kind: 'pass' }
            : { kind: 'fail', reason: `missing ${JSON.stringify(a.value)}` };
        },
      };
    case 'must_not_contain':
      return {
        id: a.assertionId,
        async check({ output }: AssertContext): Promise<AssertionResult> {
          return !String(output).includes(a.value)
            ? { kind: 'pass' }
            : { kind: 'fail', reason: `forbidden ${JSON.stringify(a.value)}` };
        },
      };
    case 'must_cite':
      return {
        id: a.assertionId,
        async check({ output }: AssertContext): Promise<AssertionResult> {
          return new RegExp(`[\\[(]${a.value}[\\])]`).test(String(output))
            ? { kind: 'pass' }
            : { kind: 'fail', reason: `missing citation ${a.value}` };
        },
      };
    case 'must_not_cite':
      return {
        id: a.assertionId,
        async check({ output }: AssertContext): Promise<AssertionResult> {
          return !new RegExp(`[\\[(]${a.value}[\\])]`).test(String(output))
            ? { kind: 'pass' }
            : { kind: 'fail', reason: `forbidden citation ${a.value}` };
        },
      };
  }
}

/**
 * Group mined assertions by trace and emit one EvalCase per trace.
 * Each case carries every assertion mined from that trace as its
 * assertion list, with input = the user turn.
 */
export function emitEvalCases(
  traces: ReadonlyArray<ConversationTrace>,
  assertions: ReadonlyArray<MinedAssertion>,
): ReadonlyArray<EvalCase> {
  const byTrace = Map.groupBy(assertions, (a) => a.traceId);
  return traces.map<EvalCase>((t) => {
    const mine = byTrace.get(t.id) ?? [];
    return {
      id: `case:${t.id}`,
      description: `Mined from trace ${t.id} (outcome=${t.outcome})`,
      input: t.userTurn,
      assertions: mine.map(predicateFor),
      labels: [t.outcome, `tenant:${t.tenantId}`],
    };
  });
}

export const VERSION = '0.0.0';
