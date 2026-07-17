/**
 * Example operator script — measures TENET + Claude Sonnet on
 * tenet-public-slice-0.1.0.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *     node --experimental-strip-types apps/measure-real/examples/anthropic-sonnet.ts
 *
 * What it produces: a RealMeasurementReport with sut: 'real', the
 * model id, and the dataset version stamped on every row. NOT a
 * hermetic CI artifact — runs locally with your key.
 *
 * Honest reading: a number from this script measures "TENET + the
 * given model on tenet-public-slice-0.1.0". It does NOT establish
 * what TENET + the same model would do on TruthfulQA / HaluEval /
 * any other dataset. To get those numbers, swap the dataset config.
 */

import { AnthropicChatModel } from '@tenet/models-anthropic';
import { TOKEN_OVERLAP_SCORER } from '@tenet/judge-hhem';
import { measureReal, makeCostMeter } from '@tenet/app-measure-real';

const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY not set');
  process.exit(2);
}

const modelId = 'claude-sonnet-4-5-20250929';

const http = {
  async fetch(url: string, init: { method: 'POST'; headers: Readonly<Record<string, string>>; body: string; signal?: AbortSignal }) {
    const r = await fetch(url, init);
    return { status: r.status, text: () => r.text() };
  },
};
// AnthropicChatModel is canonical (@tenet/core ChatRequest/ChatResponse);
// measureReal's runner is canonical too — pass it straight through.
const model = new AnthropicChatModel(http, { apiKey, model: modelId });

const cost = makeCostMeter({
  [modelId]: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
});

const report = await measureReal({
  model,
  modelId,
  // SWAP THIS for a real HHEM-2.1 via @tenet/judge-hhem-onnx for a
  // calibrated hallucination number. TOKEN_OVERLAP_SCORER is the
  // deterministic reference — useful for smoke runs, not for headlines.
  hhem: TOKEN_OVERLAP_SCORER,
  cost,
});

console.log(JSON.stringify(report, null, 2));

const anyFail = report.verdicts?.some((v) => v.kind === 'fail' || v.kind === 'missing') ?? false;
process.exit(anyFail ? 1 : 0);
