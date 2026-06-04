# @tenet/app-measure-real

Real-ChatModel BENCHMARKS runner. Composes `@tenet/models-anthropic` (or any `ChatModel`), `@tenet/judge-hhem`, and the `@tenet/eval-metrics` scorers against a small public-shape dataset (`PUBLIC_SLICE` — Apache-2.0, this repo). Operators run this locally with their own API key; the report carries `sut: 'real'` + `modelId` so it cannot be confused with the hermetic stub-SUT gate.

Swap `PUBLIC_SLICE` for real TruthfulQA / HaluEval / HELM via the `dataset` config field. License compliance for those datasets is the operator's responsibility.

```ts
import { measureReal, makeCostMeter, REAL_TARGETS } from '@tenet/app-measure-real';
import { AnthropicChatModel } from '@tenet/models-anthropic';
import { TOKEN_OVERLAP_SCORER } from '@tenet/judge-hhem';

const model = new AnthropicChatModel({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-5-20250929',
  // ... injected http
});
const cost = makeCostMeter({
  'claude-sonnet-4-5-20250929': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
});

const report = await measureReal({
  model,
  modelId: 'claude-sonnet-4-5-20250929',
  hhem: TOKEN_OVERLAP_SCORER, // replace with real HHEM-2.1
  cost,
});
console.log(JSON.stringify(report, null, 2));
```

Real HHEM-2.1: wire `@huggingface/transformers` or a hosted endpoint into a `HhemScorer`. The framework does not ship the model bytes.
