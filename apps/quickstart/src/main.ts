/**
 * Quickstart REPL — `pnpm quickstart` from the repo root.
 *
 * Zero keys: runs the full retrieve→draft→verify pipeline against the
 * deterministic stub model. Set ANTHROPIC_API_KEY for the real thing.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout, env } from 'node:process';
import { asLegacyModel } from '@tenet/core';
import { AnthropicChatModel } from '@tenet/models-anthropic';
import type { ChatModel } from '@tenet/verifier';
import { QuickstartAgent, StubChatModel } from './index.js';

function pickModel(): { model: ChatModel; label: string } {
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (apiKey !== undefined && apiKey.length > 0) {
    // AnthropicChatModel is canonical (@tenet/core ChatRequest/ChatResponse);
    // the verifier still speaks the legacy single-string shape — bridge it.
    const model = asLegacyModel(new AnthropicChatModel(
      { fetch: (input, init) => fetch(input, init) },
      { apiKey, model: env['TENET_MODEL'] ?? 'claude-sonnet-4-6' },
    ));
    return { model, label: `Anthropic (${env['TENET_MODEL'] ?? 'claude-sonnet-4-6'})` };
  }
  return { model: new StubChatModel(), label: 'offline stub (set ANTHROPIC_API_KEY for a real model)' };
}

async function main(): Promise<void> {
  const { model, label } = pickModel();
  const agent = new QuickstartAgent({ model });

  stdout.write(`\nTENET quickstart — verification-first agent\n`);
  stdout.write(`model: ${label}\n`);
  stdout.write(`Ask about TENET (e.g. "what is the verifier?"). Ctrl+C or "exit" to quit.\n\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  for (;;) {
    const question = (await rl.question('you > ')).trim();
    if (question === '' ) continue;
    if (question === 'exit' || question === 'quit') break;
    try {
      const t0 = performance.now();
      const res = await agent.ask(question);
      const ms = Math.round(performance.now() - t0);
      stdout.write(`\nagent > ${res.answer}\n`);
      if (res.citations.length > 0) {
        stdout.write(`        sources: ${res.citations.join(', ')}\n`);
      }
      stdout.write(`        [verified=${res.verified} abstained=${res.abstained} ${ms}ms]\n\n`);
    } catch (err) {
      stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n`);
    }
  }
  rl.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
