#!/usr/bin/env node
/**
 * tenet-measure-real — runs the real-model gate with whatever
 * ChatModel + HhemScorer + CostMeter the operator wires.
 *
 * This CLI is intentionally a no-op when invoked directly without a
 * config — it points the operator to the programmatic API. The real
 * usage pattern is:
 *
 *   import { measureReal, makeCostMeter } from '@tenet/app-measure-real';
 *   import { AnthropicChatModel } from '@tenet/models-anthropic';
 *
 *   const model = new AnthropicChatModel(
 *     { fetch: (url, init) => fetch(url, init) },
 *     { apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-sonnet-4-6' },
 *   );
 *   const cost = makeCostMeter({
 *     'claude-sonnet-4-6': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
 *   });
 *   const report = await measureReal({ model, modelId: '...', hhem, cost });
 *   console.log(JSON.stringify(report, null, 2));
 *
 * We do NOT auto-read env vars or auto-instantiate fetch here. Keeping
 * the CLI dumb means the operator owns: which model, which key, which
 * HTTP middleware, which cost table. That's the right altitude.
 */

console.log(`@tenet/app-measure-real — real-ChatModel BENCHMARKS runner

Usage (programmatic):
  See apps/measure-real/README.md for the snippet.

This CLI does not run a default measurement because it would require
either embedded API keys (we never ship those) or an interactive
prompt (CI-hostile). Instead, write a small operator script that
imports measureReal() and supplies your own ChatModel + HhemScorer +
CostMeter.
`);
process.exit(0);
