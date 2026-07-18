# @tenet/app-measure-real

Real-ChatModel BENCHMARKS runner. Composes `@tenet/models-anthropic` (or any `ChatModel`), `@tenet/judge-hhem`, and the `@tenet/eval-metrics` scorers against a small public-shape dataset (`PUBLIC_SLICE` — Apache-2.0, this repo). Operators run this locally with their own API key; the report carries `sut: 'real'` + `modelId` so it cannot be confused with the hermetic stub-SUT gate.

Swap `PUBLIC_SLICE` for real TruthfulQA / HaluEval / HELM via the `dataset` config field. License compliance for those datasets is the operator's responsibility.

```ts
import { measureReal, makeCostMeter } from '@tenet/app-measure-real';
import { AnthropicChatModel } from '@tenet/models-anthropic';
import { TOKEN_OVERLAP_SCORER } from '@tenet/judge-hhem';

const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
const modelId = 'claude-sonnet-4-6';

// AnthropicChatModel takes an injected http transport FIRST, then options.
const http = {
  async fetch(url: string, init: { method: 'POST'; headers: Readonly<Record<string, string>>; body: string; signal?: AbortSignal }) {
    const r = await fetch(url, init);
    return { status: r.status, text: () => r.text() };
  },
};
const model = new AnthropicChatModel(http, { apiKey, model: modelId });

const cost = makeCostMeter({
  [modelId]: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
});

const report = await measureReal({
  model,
  modelId,
  hhem: TOKEN_OVERLAP_SCORER, // swap for a real HHEM-2.1 via @tenet/judge-hhem-onnx
  cost,
});
console.log(JSON.stringify(report, null, 2));
```

Real HHEM-2.1: wire `@huggingface/transformers` or a hosted endpoint into a `HhemScorer`. The framework does not ship the model bytes.
