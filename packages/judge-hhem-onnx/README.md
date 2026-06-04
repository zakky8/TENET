# @tenet/judge-hhem-onnx

ONNX / transformers.js HhemScorer adapter for `@tenet/judge-hhem`. Wraps any local pipeline (`@huggingface/transformers`, `onnxruntime-node`) OR any hosted endpoint behind a thin `OnnxPipeline` injection. No HF/ONNX hard dep — the consumer brings the runtime + model weights + tokenizer.

```ts
import { pipeline } from '@huggingface/transformers';
import { OnnxHhemScorer } from '@tenet/judge-hhem-onnx';
import { HhemJudge } from '@tenet/judge-hhem';

const hf = await pipeline('text-classification', 'vectara/hhem-2.1-open');
const scorer = new OnnxHhemScorer({
  pipeline: { async score({ premise, hypothesis }) {
    const out = await hf({ text: premise, text_pair: hypothesis });
    return out[0].score;
  }},
  modelId: 'vectara/hhem-2.1-open',
});
const judge = new HhemJudge(scorer, { threshold: 0.5 });
```
