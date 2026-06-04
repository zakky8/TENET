/**
 * Self-distillation pipeline — captures verified flagship traces and
 * emits a fine-tune dataset for the cheap-path model.
 *
 * BENCHMARKS Dim 2 ("cost < $0.01") depends on a cheap-path model
 * whose quality climbs over time. This package ships the trace
 * capture + sampling + JSONL emission. The actual LoRA / QLoRA
 * fine-tune runs on the operator's own training infra — that side
 * is compute, not framework.
 *
 * Trace shape is intentionally LLM-provider-agnostic. The JSONL
 * emitter writes the OpenAI chat-completions style (messages array)
 * which both Anthropic's training API and HF/Llama-Factory accept.
 *
 * No I/O — the captureTrace + emitJsonl functions are pure. The
 * operator wires a persistence layer (S3 / GCS / file) on the
 * output strings.
 */

/** What a single trace looks like — what the verifier saw. */
export interface DistillationTrace {
  /** Stable trace id. */
  id: string;
  /** Tenant id; lets the dataset be partitioned by customer. */
  tenantId: string;
  /** When the trace was captured (epoch ms, supplied by caller). */
  capturedAtMs: number;
  /** System prompt the flagship answered with. */
  system: string;
  /** User turn. */
  user: string;
  /** Flagship answer that passed the verifier. */
  flagshipAnswer: string;
  /** Verifier verdict. Only traces with verdict.passed = true emit. */
  verdict: { passed: boolean; score: number };
  /** Retrieved sources at the time of the answer (for grounding). */
  sources: ReadonlyArray<{ id: string; text: string }>;
}

/** Per-tenant policy for what gets sampled. */
export interface DistillationPolicy {
  /** Drop traces whose verifier score is below this. Default 0.95. */
  minVerifierScore: number;
  /** Sample rate in (0,1]. Default 0.05 — 5%. */
  sampleRate: number;
  /**
   * Max output tokens. Larger answers are usually flagship-quality
   * but expensive to train on. Default 1024.
   */
  maxOutputChars: number;
}

export const DEFAULT_POLICY: DistillationPolicy = {
  minVerifierScore: 0.95,
  sampleRate: 0.05,
  maxOutputChars: 4096,
};

export class DistillationError extends Error {
  constructor(public readonly code: 'invalid_policy' | 'invalid_trace', message: string) {
    super(message);
    this.name = 'DistillationError';
  }
}

/**
 * Decide whether a trace should be sampled into the training set.
 * Pure + deterministic: `rng` is supplied by caller so the decision
 * is reproducible from logs.
 */
export function shouldSample(
  trace: DistillationTrace,
  policy: DistillationPolicy,
  rng: () => number,
): { keep: true } | { keep: false; reason: string } {
  if (policy.sampleRate <= 0 || policy.sampleRate > 1) {
    throw new DistillationError('invalid_policy', `sampleRate must be in (0,1], got ${policy.sampleRate}`);
  }
  if (!trace.verdict.passed) return { keep: false, reason: 'verdict_failed' };
  if (trace.verdict.score < policy.minVerifierScore) {
    return { keep: false, reason: `score ${trace.verdict.score} < min ${policy.minVerifierScore}` };
  }
  if (trace.flagshipAnswer.length > policy.maxOutputChars) {
    return { keep: false, reason: `answer ${trace.flagshipAnswer.length} > max ${policy.maxOutputChars}` };
  }
  if (rng() > policy.sampleRate) return { keep: false, reason: 'sampling' };
  return { keep: true };
}

/** OpenAI chat-completions JSONL row shape. Anthropic + HF accept it. */
export interface JsonlRow {
  messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Provenance — the trace id, score, tenant. */
  metadata: { traceId: string; tenantId: string; verifierScore: number };
}

/** Convert a kept trace to a JSONL row. Pure. */
export function traceToJsonl(trace: DistillationTrace): JsonlRow {
  // Splice sources into the system prompt so the cheap-path model
  // learns to use the same grounding contract.
  const sourcesBlock = trace.sources.length === 0
    ? ''
    : '\n\nSources:\n' + trace.sources.map((s) => `[${s.id}] ${s.text}`).join('\n');
  return {
    messages: [
      { role: 'system', content: trace.system + sourcesBlock },
      { role: 'user', content: trace.user },
      { role: 'assistant', content: trace.flagshipAnswer },
    ],
    metadata: {
      traceId: trace.id,
      tenantId: trace.tenantId,
      verifierScore: trace.verdict.score,
    },
  };
}

/** Emit the full JSONL file as one string. Caller writes to disk. */
export function emitJsonl(rows: ReadonlyArray<JsonlRow>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * One-shot batch: filter + sample + emit. Convenience over the
 * per-trace functions. Returns both the emitted string and a per-trace
 * outcome list for telemetry.
 */
export function buildDataset(
  traces: ReadonlyArray<DistillationTrace>,
  policy: DistillationPolicy,
  rng: () => number,
): {
  jsonl: string;
  kept: number;
  dropped: ReadonlyArray<{ traceId: string; reason: string }>;
} {
  const rows: JsonlRow[] = [];
  const dropped: Array<{ traceId: string; reason: string }> = [];
  for (const t of traces) {
    const decision = shouldSample(t, policy, rng);
    if (decision.keep) {
      rows.push(traceToJsonl(t));
    } else {
      dropped.push({ traceId: t.id, reason: decision.reason });
    }
  }
  return { jsonl: emitJsonl(rows), kept: rows.length, dropped };
}

export const VERSION = '0.0.0';
