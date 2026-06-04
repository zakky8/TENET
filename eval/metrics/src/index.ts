/**
 * BENCHMARKS scorers — pure, deterministic, dependency-free.
 *
 * One function per BENCHMARKS.md dimension. Each function takes a raw
 * evidence shape (samples, spans, judged outcomes, golden labels, …)
 * and returns a MetricResult that the CI gate compares to the row's
 * target. No I/O. No fetch. No model calls. The model-call side lives
 * upstream in eval-harness; this layer just measures what came back.
 *
 * Why this is split out:
 *   - Auditable. Anyone can re-run the scorer over the raw JSON dump.
 *   - Versionable. Scorers carry a `version` so historic numbers can be
 *     replayed against the same algorithm.
 *   - Hermetic in CI. No network. Same input → same number, always.
 *
 * Per CLAUDE.md source-hierarchy rule: a number produced by this
 * package is Tier-1 evidence *for the framework's behavior on the
 * given dataset*. It is not a claim about the underlying model.
 */

// ── Common shapes ──────────────────────────────────────────────────────

export type MetricUnit = 'rate' | 'usd' | 'ms' | 'count' | 'score';

export interface MetricResult {
  /** Stable id matching the BENCHMARKS row + sub-metric, e.g. `hallucination_rate`. */
  metric: string;
  /** Scorer algorithm version. Bump on any scoring-rule change. */
  version: string;
  /** The measured value. */
  value: number;
  unit: MetricUnit;
  /** N over which the value was computed. */
  sampleSize: number;
  /** Wilson 95% CI for rate metrics, [lo, hi]; absent for non-rates. */
  ci95?: readonly [number, number];
  /** Anything the gate or report needs that doesn't fit the value. */
  extra?: Readonly<Record<string, number | string>>;
}

export const SCORER_VERSION = '0.1.0';

// ── Numeric helpers (deterministic, no Math.random / Date.now) ────────

/** P-quantile via sorted-array index. Linear interpolation between neighbors. */
export function quantile(samples: ReadonlyArray<number>, p: number): number {
  if (samples.length === 0) throw new Error('quantile: empty samples');
  if (p < 0 || p > 1) throw new Error(`quantile: p out of range: ${p}`);
  const xs = samples.toSorted((a, b) => a - b);
  const pos = p * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loVal = xs[lo]!;
  if (lo === hi) return loVal;
  const hiVal = xs[hi]!;
  return loVal + (hiVal - loVal) * (pos - lo);
}

/** Wilson score interval for a binomial proportion at 95% confidence. */
export function wilson95(successes: number, n: number): readonly [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.959963984540054; // 97.5th percentile of standard normal
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ── Dim 1 — Hallucination ─────────────────────────────────────────────

/**
 * A single LLM-as-judge or HHEM-like verdict on one model answer.
 * `supported` = the answer is grounded in the supplied sources.
 */
export interface HallucinationVerdict {
  caseId: string;
  /** True when the answer is grounded; false when the verdict says hallucinated. */
  supported: boolean;
}

export function hallucinationRate(verdicts: ReadonlyArray<HallucinationVerdict>): MetricResult {
  const n = verdicts.length;
  const hallucinated = verdicts.filter((v) => !v.supported).length;
  const value = n === 0 ? 0 : hallucinated / n;
  return {
    metric: 'hallucination_rate',
    version: SCORER_VERSION,
    value,
    unit: 'rate',
    sampleSize: n,
    ci95: wilson95(hallucinated, n),
  };
}

/**
 * Atomic-claim groundedness — fraction of extracted claims that have at
 * least one matching span in the supplied source chunks. This is the
 * verifier's contract; we just count the result.
 */
export interface ClaimGrounding {
  claimId: string;
  /** True when the verifier found a backing source span for this claim. */
  grounded: boolean;
}

export function groundednessRate(claims: ReadonlyArray<ClaimGrounding>): MetricResult {
  const n = claims.length;
  const grounded = claims.filter((c) => c.grounded).length;
  const value = n === 0 ? 1 : grounded / n;
  return {
    metric: 'groundedness_rate',
    version: SCORER_VERSION,
    value,
    unit: 'rate',
    sampleSize: n,
    ci95: wilson95(grounded, n),
  };
}

// ── Dim 2 — Cost per resolution ───────────────────────────────────────

/** One outcome record per conversation. */
export interface ResolutionCostSample {
  conversationId: string;
  /** True when the conversation reached a terminal `resolved` outcome. */
  resolved: boolean;
  /** Total USD spent across all model + tool calls in this conversation. */
  costUsd: number;
}

export function costPerResolution(samples: ReadonlyArray<ResolutionCostSample>): MetricResult {
  const resolved = samples.filter((s) => s.resolved);
  const n = resolved.length;
  const totalCost = resolved.reduce((acc, s) => acc + s.costUsd, 0);
  const value = n === 0 ? 0 : totalCost / n;
  return {
    metric: 'cost_per_resolution_usd',
    version: SCORER_VERSION,
    value,
    unit: 'usd',
    sampleSize: n,
    extra: { resolved_count: n, total_count: samples.length },
  };
}

// ── Dim 3 — TTFT p95 ───────────────────────────────────────────────────

export interface LatencySample {
  caseId: string;
  /** Time-to-first-token, ms. */
  ttftMs: number;
  /** End-to-end resolution time, ms. */
  e2eMs: number;
}

export function ttftP95(samples: ReadonlyArray<LatencySample>): MetricResult {
  return {
    metric: 'ttft_p95_ms',
    version: SCORER_VERSION,
    value: samples.length === 0 ? 0 : quantile(samples.map((s) => s.ttftMs), 0.95),
    unit: 'ms',
    sampleSize: samples.length,
  };
}

export function e2eLatencyP95(samples: ReadonlyArray<LatencySample>): MetricResult {
  return {
    metric: 'e2e_latency_p95_ms',
    version: SCORER_VERSION,
    value: samples.length === 0 ? 0 : quantile(samples.map((s) => s.e2eMs), 0.95),
    unit: 'ms',
    sampleSize: samples.length,
  };
}

// ── Dim 7 — Tool-call success ─────────────────────────────────────────

export interface ToolCallOutcome {
  /** Per-call id. */
  id: string;
  /** True when the tool returned without throwing AND output matched the call's success contract. */
  success: boolean;
}

export function toolCallSuccessRate(outcomes: ReadonlyArray<ToolCallOutcome>): MetricResult {
  const n = outcomes.length;
  const ok = outcomes.filter((o) => o.success).length;
  const value = n === 0 ? 1 : ok / n;
  return {
    metric: 'tool_call_success_rate',
    version: SCORER_VERSION,
    value,
    unit: 'rate',
    sampleSize: n,
    ci95: wilson95(ok, n),
  };
}

// ── Dim 10 — Prompt-injection block rate ──────────────────────────────

export interface InjectionAttempt {
  attemptId: string;
  /** True when the guardrail correctly refused / sanitized / flagged. */
  blocked: boolean;
}

export function injectionBlockRate(attempts: ReadonlyArray<InjectionAttempt>): MetricResult {
  const n = attempts.length;
  const blocked = attempts.filter((a) => a.blocked).length;
  const value = n === 0 ? 1 : blocked / n;
  return {
    metric: 'injection_block_rate',
    version: SCORER_VERSION,
    value,
    unit: 'rate',
    sampleSize: n,
    ci95: wilson95(blocked, n),
  };
}

// ── Dim 8 — Retrieval recall@K ────────────────────────────────────────

export interface RetrievalSample {
  queryId: string;
  /** Ordered chunk ids the retriever returned, best first. */
  returnedIds: ReadonlyArray<string>;
  /** Ground-truth relevant chunk ids for the query. */
  relevantIds: ReadonlyArray<string>;
}

export function retrievalRecallAtK(samples: ReadonlyArray<RetrievalSample>, k: number): MetricResult {
  if (k <= 0) throw new Error(`retrievalRecallAtK: k must be > 0, got ${k}`);
  if (samples.length === 0) {
    return { metric: `retrieval_recall_at_${k}`, version: SCORER_VERSION, value: 1, unit: 'rate', sampleSize: 0 };
  }
  let recallSum = 0;
  let included = 0;
  for (const s of samples) {
    if (s.relevantIds.length === 0) continue; // skip un-labeled queries
    const topK = new Set(s.returnedIds.slice(0, k));
    const hits = s.relevantIds.filter((id) => topK.has(id)).length;
    recallSum += hits / s.relevantIds.length;
    included++;
  }
  return {
    metric: `retrieval_recall_at_${k}`,
    version: SCORER_VERSION,
    value: included === 0 ? 1 : recallSum / included,
    unit: 'rate',
    sampleSize: included,
  };
}

// ── Dim 3-side — Router decision quality ──────────────────────────────

/**
 * Routing-accuracy check. Each sample is one decision; we compare to
 * an oracle label (often: which model would have been cheapest while
 * still passing the verifier).
 */
export interface RouterDecisionSample {
  caseId: string;
  chosen: string; // e.g. 'haiku' | 'sonnet' | 'opus'
  oracle: string;
}

export function routerDecisionAccuracy(samples: ReadonlyArray<RouterDecisionSample>): MetricResult {
  const n = samples.length;
  const correct = samples.filter((s) => s.chosen === s.oracle).length;
  const value = n === 0 ? 1 : correct / n;
  return {
    metric: 'router_decision_accuracy',
    version: SCORER_VERSION,
    value,
    unit: 'rate',
    sampleSize: n,
    ci95: wilson95(correct, n),
  };
}

// ── Dim 9 — Determinism ───────────────────────────────────────────────

/**
 * Determinism — fraction of (caseId) groups where every run produced
 * a byte-identical output. Used to gate the verifier path under temp=0.
 */
export interface DeterminismSample {
  caseId: string;
  /** ≥ 2 outputs from independent runs of the same case. */
  outputs: ReadonlyArray<string>;
}

export function determinismRate(samples: ReadonlyArray<DeterminismSample>): MetricResult {
  const usable = samples.filter((s) => s.outputs.length >= 2);
  const n = usable.length;
  const stable = usable.filter((s) => s.outputs.every((o) => o === s.outputs[0])).length;
  const value = n === 0 ? 1 : stable / n;
  return {
    metric: 'determinism_rate',
    version: SCORER_VERSION,
    value,
    unit: 'rate',
    sampleSize: n,
    ci95: wilson95(stable, n),
  };
}

// ── Gate ───────────────────────────────────────────────────────────────

export type Direction = 'minimize' | 'maximize';

export interface BenchmarkTarget {
  metric: string;
  target: number;
  unit: MetricUnit;
  direction: Direction;
  /** Optional baseline value from prior run; used for regression delta. */
  baseline?: number;
  /** Max allowed regression (absolute, in metric units) vs baseline. */
  regressionToleranceAbs?: number;
}

export type GateVerdict =
  | { kind: 'pass'; metric: string; measured: number; target: number }
  | { kind: 'fail'; metric: string; measured: number; target: number; reason: string }
  | { kind: 'missing'; metric: string };

/**
 * Compare a set of measured MetricResults to the BENCHMARKS targets and
 * return per-metric verdicts. The CI workflow turns any `fail` into a
 * non-zero exit code.
 */
export function gate(
  measured: ReadonlyArray<MetricResult>,
  targets: ReadonlyArray<BenchmarkTarget>,
): ReadonlyArray<GateVerdict> {
  const byMetric = new Map(measured.map((m) => [m.metric, m]));
  return targets.map((t): GateVerdict => {
    const m = byMetric.get(t.metric);
    if (!m) return { kind: 'missing', metric: t.metric };
    const hitsTarget =
      t.direction === 'minimize' ? m.value <= t.target : m.value >= t.target;
    if (!hitsTarget) {
      return {
        kind: 'fail',
        metric: t.metric,
        measured: m.value,
        target: t.target,
        reason: `${m.metric}=${m.value} ${t.direction === 'minimize' ? '>' : '<'} target ${t.target}`,
      };
    }
    if (t.baseline !== undefined && t.regressionToleranceAbs !== undefined) {
      const regressed =
        t.direction === 'minimize'
          ? m.value - t.baseline > t.regressionToleranceAbs
          : t.baseline - m.value > t.regressionToleranceAbs;
      if (regressed) {
        return {
          kind: 'fail',
          metric: t.metric,
          measured: m.value,
          target: t.target,
          reason: `regression vs baseline ${t.baseline} exceeds tolerance ${t.regressionToleranceAbs}`,
        };
      }
    }
    return { kind: 'pass', metric: t.metric, measured: m.value, target: t.target };
  });
}

export const VERSION = '0.0.0';
