/**
 * Example wiring — Vectara HHEM-2.1 via @huggingface/transformers.
 *
 * Operator installs @huggingface/transformers themselves (we never
 * hard-dep the runtime). This file shows exactly how to plug a real
 * HF pipeline into @tenet/judge-hhem-onnx's OnnxPipeline contract.
 *
 *   npm i @huggingface/transformers
 *   ANTHROPIC_API_KEY=... node --experimental-strip-types \
 *     packages/judge-hhem-onnx/examples/transformers-pipeline.ts
 *
 * Honest scope: this is the wiring; the model weights download on
 * first run (~~100MB for hhem-2.1-open quantised). Cold start adds
 * ~3-8s; warm calls run in <50ms on CPU. No network after warmup.
 */

// @ts-expect-error -- not in this workspace's deps; operator installs.
import { pipeline } from '@huggingface/transformers';
import { OnnxHhemScorer, sigmoid } from '@tenet/judge-hhem-onnx';
import { HhemJudge } from '@tenet/judge-hhem';

// 1. Warm the cross-encoder once. transformers.js loads the ONNX model
//    + tokeniser + writes them to the local cache.
const classifier = await pipeline('text-classification', 'vectara/hhem-2.1-open', {
  // quantised for CPU-friendliness; drop for full precision.
  quantized: true,
});

// 2. Adapt classifier output to the OnnxPipeline contract. HHEM-2.1
//    returns label/score in [0,1] entailment shape, so no rescale.
const scorer = new OnnxHhemScorer({
  modelId: 'vectara/hhem-2.1-open',
  pipeline: {
    async score({ premise, hypothesis }) {
      // HF cross-encoder API takes pair via `text` + `text_pair`.
      const out = await classifier({ text: premise, text_pair: hypothesis });
      // Some HF builds wrap the result in an array.
      const row = Array.isArray(out) ? out[0] : out;
      return Number(row.score);
    },
  },
  // If your build returns logits instead of probabilities, uncomment:
  // rescale: sigmoid,
});
void sigmoid; // referenced for the comment above

// 3. Vectara recommends threshold 0.5 for HHEM-2.1. Drop the threshold
//    if you want the gate to accept marginal entailment.
const judge = new HhemJudge(scorer, { threshold: 0.5, concurrency: 4 });

const verdict = await judge.judge({
  caseId: 'demo',
  claimId: 'c1',
  premise: 'Paris is the capital city of France, located on the Seine river.',
  hypothesis: 'Paris is the capital of France.',
});
console.log(verdict);
// → { caseId: 'demo', supported: true, score: ~0.99 }
