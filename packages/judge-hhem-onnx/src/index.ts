/**
 * ONNX / transformers.js HhemScorer adapter.
 *
 * Vectara HHEM-2.1 is published as an ONNX cross-encoder. This module
 * wraps any local pipeline (`@huggingface/transformers`, `onnxruntime-
 * node`) OR any hosted endpoint behind the @tenet/judge-hhem HhemScorer
 * contract. We do NOT hard-depend on either: the pipeline is injected
 * as a thin `OnnxPipeline` interface, so the consumer's bundle has the
 * model weights, the runtime, and the tokenizer — not us.
 *
 * Why split out from judge-hhem:
 *   - judge-hhem ships the verdict logic + a deterministic reference
 *     scorer (zero deps). Anyone using judge-hhem alone gets a
 *     zero-install package.
 *   - judge-hhem-onnx is the operator's choice of runtime. The split
 *     lets us version the scoring contract independent of the runtime
 *     adapter.
 */

import type { HhemScorer } from '@tenet/judge-hhem';

/** Minimal contract for an HHEM-style cross-encoder pipeline. */
export interface OnnxPipeline {
  /**
   * Score one (premise, hypothesis) pair. Implementations:
   *   - transformers.js: `pipeline('text-classification', 'vectara/hhem-2.1-open')`
   *   - hosted: any HTTP endpoint that returns {score:number}
   * Must return a probability-shaped score in [0,1].
   */
  score(args: { premise: string; hypothesis: string; signal?: AbortSignal }): Promise<number>;
}

export interface OnnxHhemScorerConfig {
  pipeline: OnnxPipeline;
  /**
   * Optional rescaler. HHEM returns a probability; some pipelines return
   * logits. Supply a sigmoid wrapper if your pipeline does.
   */
  rescale?: (raw: number) => number;
  /** Optional model id label for telemetry. */
  modelId?: string;
}

export class OnnxHhemScorer implements HhemScorer {
  constructor(private readonly config: OnnxHhemScorerConfig) {}

  async score(args: { premise: string; hypothesis: string; signal?: AbortSignal }): Promise<number> {
    const raw = await this.config.pipeline.score(args);
    const r = this.config.rescale ? this.config.rescale(raw) : raw;
    if (!Number.isFinite(r)) {
      throw new Error(`OnnxHhemScorer: pipeline returned non-finite ${raw}`);
    }
    return Math.min(1, Math.max(0, r));
  }

  get modelId(): string | undefined {
    return this.config.modelId;
  }
}

/** Sigmoid for pipelines that return logits. */
export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

export const VERSION = '0.0.0';
