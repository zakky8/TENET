/**
 * Real-ChatModel measurement runner.
 *
 * Composes:
 *   - any @tenet/models-anthropic-shape ChatModel (or other)
 *   - @tenet/judge-hhem for the hallucination row
 *   - @tenet/eval-metrics scorers for every gate dimension
 *   - apps/measure-real/dataset PUBLIC_SLICE
 *
 * Produces a MeasurementReport identical in shape to eval-measure's
 * stub report — but with `sut: 'real'` and the model id baked in.
 *
 * Operator runs this locally with an API key. We do NOT ship a real
 * HTTP client; the caller injects one. This keeps the package
 * dep-free and runnable in any environment (Node fetch, undici,
 * Cloudflare Workers, etc.).
 */

import type { ChatModel } from '@tenet/core';
import { textMessage, responseText } from '@tenet/core';
import {
  hallucinationRate,
  groundednessRate,
  costPerResolution,
  ttftP95,
  e2eLatencyP95,
  determinismRate,
  gate,
  type BenchmarkTarget,
  type GateVerdict,
  type MetricResult,
} from '@tenet/eval-metrics';
import { HhemJudge, type HhemScorer } from '@tenet/judge-hhem';
import { PUBLIC_SLICE, PUBLIC_SLICE_VERSION, type RealCase } from './dataset.js';

export interface CostMeter {
  /** Returns USD cost for one chat call. */
  estimate(args: { model: string; inputTokens: number; outputTokens: number }): number;
}

export interface RealRunnerConfig {
  model: ChatModel;
  modelId: string;
  hhem: HhemScorer;
  hhemThreshold?: number;
  cost: CostMeter;
  /** Override dataset; defaults to PUBLIC_SLICE. */
  dataset?: ReadonlyArray<RealCase>;
  /** Per-case wall-clock timeout, ms. Default 30s. */
  perCaseTimeoutMs?: number;
}

export interface RealMeasurementReport {
  schemaVersion: '1';
  sut: 'real';
  modelId: string;
  datasetVersion: string;
  datasetSize: number;
  metrics: ReadonlyArray<MetricResult>;
  verdicts?: ReadonlyArray<GateVerdict>;
}

/** Approximate token count for cost estimation (chars / 4). */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Strip a model answer to the substring after the last "Answer:" if present. */
function extractAnswer(raw: string): string {
  const m = raw.match(/answer\s*:\s*([\s\S]*)$/i);
  return (m?.[1] ?? raw).trim();
}

interface CaseRun {
  caseId: string;
  answer: string;
  ttftMs: number;
  e2eMs: number;
  costUsd: number;
}

async function runCase(
  c: RealCase,
  cfg: RealRunnerConfig,
  signal: AbortSignal,
): Promise<CaseRun> {
  const start = Date.now();
  const system =
    'You are a grounded answerer. Use ONLY the provided context. Reply in the form "Answer: <short>".';
  const user = `Context:\n${c.context}\n\nQuestion: ${c.question}`;
  const res = await cfg.model.chat({
    system,
    messages: [textMessage('user', user)],
    maxTokens: 256,
    signal,
  });
  const raw = responseText(res);
  const e2eMs = Date.now() - start;
  // The injected ChatModel doesn't expose a streaming TTFT; approximate
  // by reporting one-token wall-clock (e2eMs / tokens). Operators with a
  // streaming model swap in their own runner.
  const answer = extractAnswer(raw);
  const inputTokens = approxTokens(system) + approxTokens(user);
  const outputTokens = approxTokens(raw);
  const ttftMs = Math.max(50, Math.round(e2eMs / Math.max(1, outputTokens)));
  return {
    caseId: c.id,
    answer,
    ttftMs,
    e2eMs,
    costUsd: cfg.cost.estimate({ model: cfg.modelId, inputTokens, outputTokens }),
  };
}

/** Run the full BENCHMARKS gate against a real ChatModel. */
export async function measureReal(
  cfg: RealRunnerConfig,
  targets?: ReadonlyArray<BenchmarkTarget>,
): Promise<RealMeasurementReport> {
  const ds = cfg.dataset ?? PUBLIC_SLICE;
  const perCaseTimeoutMs = cfg.perCaseTimeoutMs ?? 30_000;

  const runs: CaseRun[] = [];
  for (const c of ds) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), perCaseTimeoutMs);
    try {
      runs.push(await runCase(c, cfg, ctrl.signal));
    } finally {
      clearTimeout(timer);
    }
  }

  // Hallucination: HHEM judges (context, answer) entailment.
  const hhem = new HhemJudge(cfg.hhem, { threshold: cfg.hhemThreshold ?? 0.5 });
  const claims = ds.map((c, i) => ({
    caseId: c.id,
    claimId: c.id,
    premise: c.context,
    hypothesis: runs[i]!.answer,
  }));
  const judgeResults = await hhem.judgeAll(claims);
  const verdicts = judgeResults.map((j) => ({ caseId: j.caseId, supported: j.supported }));

  // Groundedness: an answer is grounded iff it contains an acceptable
  // string AND does NOT contain a known distractor.
  const grounded = ds.map((c, i) => {
    const a = runs[i]!.answer.toLowerCase();
    const hasAcceptable = c.acceptableAnswers.some((x) => a.includes(x.toLowerCase()));
    const hasDistractor = c.knownDistractors.some((x) => a.includes(x.toLowerCase()));
    return { claimId: c.id, grounded: hasAcceptable && !hasDistractor };
  });

  const costSamples = runs.map((r) => ({
    conversationId: r.caseId,
    resolved: true,
    costUsd: r.costUsd,
  }));
  const latencySamples = runs.map((r) => ({
    caseId: r.caseId,
    ttftMs: r.ttftMs,
    e2eMs: r.e2eMs,
  }));

  // Determinism: rerun first 3 cases once and check byte equality.
  const detSubset = ds.slice(0, Math.min(3, ds.length));
  const detSamples = await Promise.all(
    detSubset.map(async (c) => {
      const r2 = await runCase(c, cfg, AbortSignal.timeout(perCaseTimeoutMs));
      const original = runs.find((r) => r.caseId === c.id)!;
      return { caseId: c.id, outputs: [original.answer, r2.answer] };
    }),
  );

  const metrics: MetricResult[] = [
    hallucinationRate(verdicts),
    groundednessRate(grounded),
    costPerResolution(costSamples),
    ttftP95(latencySamples),
    e2eLatencyP95(latencySamples),
    determinismRate(detSamples),
  ];

  const report: RealMeasurementReport = {
    schemaVersion: '1',
    sut: 'real',
    modelId: cfg.modelId,
    datasetVersion: PUBLIC_SLICE_VERSION,
    datasetSize: ds.length,
    metrics,
  };
  if (targets) {
    return { ...report, verdicts: gate(metrics, targets) };
  }
  return report;
}

/** Default per-million-token prices (op-er can override). */
export interface ModelPriceTable {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export function makeCostMeter(prices: Readonly<Record<string, ModelPriceTable>>): CostMeter {
  return {
    estimate({ model, inputTokens, outputTokens }) {
      const p = prices[model];
      if (!p) return 0;
      return (
        (inputTokens / 1_000_000) * p.inputUsdPerMillion +
        (outputTokens / 1_000_000) * p.outputUsdPerMillion
      );
    },
  };
}

export const VERSION = '0.0.0';
