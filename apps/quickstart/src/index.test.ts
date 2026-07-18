import type { ChatResponse } from '@tenet/core';
import { QuickstartAgent, StubChatModel, QUICKSTART_KB, ABSTAIN_REPLY } from './index.js';
import type { ChatModel } from '@tenet/verifier';

function textResponse(text: string): ChatResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

describe('QuickstartAgent with the stub model (the zero-key path)', () => {
  it('answers a question through the full retrieve→draft→verify pipeline', async () => {
    const agent = new QuickstartAgent({ model: new StubChatModel() });
    const res = await agent.ask('What does the verifier do?');
    expect(res.abstained).toBe(false);
    expect(res.verified).toBe(true);
    expect(res.answer.length).toBeGreaterThan(0);
    // The stub grounds its draft in the retrieved KNOWLEDGE block.
    const kbTexts = QUICKSTART_KB.map((s) => s.text);
    expect(kbTexts.some((t) => res.answer.includes(t.slice(0, 40)))).toBe(true);
  });

  it('returns citations referencing real KB uris', async () => {
    const agent = new QuickstartAgent({ model: new StubChatModel() });
    const res = await agent.ask('How does durable execution work in TENET?');
    expect(res.verified).toBe(true);
    for (const uri of res.citations) {
      expect(QUICKSTART_KB.map((s) => s.uri)).toContain(uri);
    }
  });

  it('prompts for input on empty question', async () => {
    const agent = new QuickstartAgent({ model: new StubChatModel() });
    const res = await agent.ask('   ');
    expect(res.answer).toMatch(/ask me/i);
  });
});

describe('QuickstartAgent abstention (verification-first behaviour)', () => {
  it('abstains when the judge rejects the draft claims', async () => {
    // Model that drafts confidently but whose claims get judged UNSUPPORTED.
    const liar: ChatModel = {
      async chat({ system }) {
        if (system.includes('extract atomic')) return textResponse('TENET was founded on Mars in 1850.');
        if (system.toLowerCase().includes('judge')) return textResponse('[1] UNSUPPORTED');
        return textResponse('TENET was founded on Mars in 1850.');
      },
    };
    const agent = new QuickstartAgent({ model: liar });
    const res = await agent.ask('Where was TENET founded?');
    expect(res.abstained).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.answer).toBe(ABSTAIN_REPLY);
    expect(res.citations).toEqual([]);
  });
});

// ── Real-model smoke test (network-gated) ─────────────────────────────
// Runs the SAME retrieve→draft→verify pipeline against a real Anthropic
// model and asserts an in-scope question yields a VERIFIED, CITED answer
// (never a bare ungrounded string). Registered ONLY when ANTHROPIC_API_KEY
// is set, so the offline suite stays hermetic and its count is unchanged;
// with no key the block does not exist in the run (not even as a skip).
// NOTE: un-validated against a live model in CI (no key there) — only its
// gating + compilation are checked offline.
const apiKey = process.env['ANTHROPIC_API_KEY'];
if (apiKey !== undefined && apiKey.length > 0) {
  describe('QuickstartAgent against a real Anthropic model (network-gated)', () => {
    it('answers an in-scope question with a verified, cited result', async () => {
      if (apiKey === undefined) throw new Error('unreachable: gated on apiKey');
      const { AnthropicChatModel } = await import('@tenet/models-anthropic');
      const model = new AnthropicChatModel(
        { fetch: (input, init) => fetch(input, init) },
        { apiKey, model: process.env['TENET_MODEL'] ?? 'claude-sonnet-4-6' },
      );
      const agent = new QuickstartAgent({ model });
      const res = await agent.ask('What does the TENET verifier do?');
      expect(res.abstained).toBe(false);
      expect(res.verified).toBe(true);
      expect(res.citations.length).toBeGreaterThan(0);
    }, 30_000);
  });
}
