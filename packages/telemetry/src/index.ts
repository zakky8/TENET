/**
 * TENET telemetry — OpenTelemetry GenAI semconv + outcome events.
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * Vendor-neutral by design. Operators export OTLP to whatever sink they
 * want (LangSmith / Braintrust / Phoenix / Langfuse / Helicone / Tempo /
 * Jaeger). Pricing-tier metric `agent.cost_usd` and `agent.outcome` are
 * native primitives, not vendor add-ons.
 */

import type { Outcome, OutcomeEvent } from '@tenet/core';

// ── OTel GenAI semconv attribute keys (subset we use) ───────────────────────

export const ATTR = {
  // GenAI semconv (https://opentelemetry.io/docs/specs/semconv/gen-ai/)
  GEN_AI_SYSTEM: 'gen_ai.system',
  GEN_AI_REQUEST_MODEL: 'gen_ai.request.model',
  GEN_AI_REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  GEN_AI_REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  GEN_AI_USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  GEN_AI_USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  GEN_AI_RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  GEN_AI_RESPONSE_TIME_TO_FIRST_TOKEN_MS: 'gen_ai.response.time_to_first_token_ms',

  // TENET-specific (under agent.* namespace per OTel guidance)
  AGENT_OUTCOME: 'agent.outcome',
  AGENT_VERIFIER_PASSED: 'agent.verifier.passed',
  AGENT_VERIFIER_FAILURES: 'agent.verifier.failures',
  AGENT_SURFACE: 'agent.surface',
  AGENT_TENANT_ID: 'agent.tenant_id',
  AGENT_INTENT: 'agent.intent',
  AGENT_COST_USD: 'agent.cost_usd',
  AGENT_TURN_DURATION_MS: 'agent.turn.duration_ms',
  AGENT_RETRIEVAL_RECALL_BM25: 'agent.retrieval.recall_at_k.bm25',
  AGENT_RETRIEVAL_RECALL_DENSE: 'agent.retrieval.recall_at_k.dense',
  AGENT_RETRIEVAL_RECALL_FUSED: 'agent.retrieval.recall_at_k.fused',
  AGENT_RETRIEVAL_RECALL_RERANKED: 'agent.retrieval.recall_at_k.reranked',
} as const;

export type AttrKey = (typeof ATTR)[keyof typeof ATTR];

// ── Outcome emitter ─────────────────────────────────────────────────────────

export type OutcomeSink = (e: OutcomeEvent) => void;

/** Allowed outcomes — used for runtime validation. */
const VALID_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([
  'resolved',
  'handed_off',
  'disqualified',
  'qualified',
  'pending',
]);

export class OutcomeEmitter {
  constructor(private readonly sinks: ReadonlyArray<OutcomeSink>) {}

  emit(e: OutcomeEvent): void {
    if (!VALID_OUTCOMES.has(e.outcome)) {
      throw new Error(`Invalid outcome: ${JSON.stringify(e.outcome)}`);
    }
    if (e.durationMs < 0) {
      throw new Error(`durationMs must be >= 0, got ${e.durationMs}`);
    }
    if (e.costUsd < 0) {
      throw new Error(`costUsd must be >= 0, got ${e.costUsd}`);
    }
    if (!e.conversationId || !e.tenantId) {
      throw new Error(`conversationId and tenantId are required`);
    }
    for (const sink of this.sinks) {
      // Sink failures are isolated — one broken sink doesn't kill telemetry.
      try {
        sink(e);
      } catch {
        // swallow — telemetry must not break the agent
      }
    }
  }
}

// ── Span attribute helpers ──────────────────────────────────────────────────

export interface SpanAttributes {
  [k: string]: string | number | boolean | undefined;
}

/** Build a sanitized OTel attribute bag from a free-form record. */
export function buildAttributes(
  raw: Readonly<Record<string, unknown>>,
): SpanAttributes {
  const out: SpanAttributes = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      out[k] = v as string | number | boolean;
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      // OTel allows string[] but we flatten for our simple bag
      out[k] = (v as string[]).join(',');
    }
    // else: skip (objects, functions, symbols, mixed arrays)
  }
  return out;
}

// ── Cost meter ──────────────────────────────────────────────────────────────

/**
 * Token-cost accumulator. Per-turn instance; final value emitted as
 * agent.cost_usd. Operators register a model→price table.
 */
export interface ModelPrice {
  /** USD per million INPUT tokens. */
  inputPerMillion: number;
  /** USD per million OUTPUT tokens. */
  outputPerMillion: number;
}

export class CostMeter {
  private totalUsd = 0;
  constructor(private readonly priceTable: Readonly<Record<string, ModelPrice>>) {}

  record(model: string, inputTokens: number, outputTokens: number): void {
    if (inputTokens < 0 || outputTokens < 0) {
      throw new Error('token counts must be >= 0');
    }
    const price = this.priceTable[model];
    if (!price) return; // unknown model — skip silently rather than overcounting at 0
    this.totalUsd +=
      (inputTokens / 1_000_000) * price.inputPerMillion +
      (outputTokens / 1_000_000) * price.outputPerMillion;
  }

  total(): number {
    return this.totalUsd;
  }

  reset(): void {
    this.totalUsd = 0;
  }
}

export const VERSION = '0.0.0';
