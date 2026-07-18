import type { ChatRequest, ChatResponse } from '@tenet/core';
import { verifyDraft } from './verifier.js';
import type { ChatModel } from './types.js';

function textResponse(text: string): ChatResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

/** Flatten a canonical request's message content back to the legacy
 *  single `user` string these tests were written against. */
function reqUserText(req: ChatRequest): string {
  return req.messages
    .flatMap((m) => m.content)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}

/**
 * Sequential mock: returns scripted replies in order. Use to script
 * (extract response, strict judge response, permissive judge response).
 */
function scriptedModel(replies: string[]): ChatModel {
  let i = 0;
  return {
    chat: async () => {
      const r = replies[i] ?? '';
      i++;
      return textResponse(r);
    },
  };
}

describe('verifyDraft — empty + trivial cases', () => {
  it('passes a draft with no factual claims (extractor returns NONE)', async () => {
    const model = scriptedModel(['NONE']);
    const out = await verifyDraft(model, { sources: 'srcs', draft: 'Hello, how are you?' });
    expect(out.pass).toBe(true);
    expect(out.verdicts).toEqual([]);
  });

  it('passes when extractor returns empty string', async () => {
    const model = scriptedModel(['']);
    const out = await verifyDraft(model, { sources: '', draft: 'x' });
    expect(out.pass).toBe(true);
  });

  it('passes when draft is empty', async () => {
    const model = scriptedModel([]); // never called
    const out = await verifyDraft(model, { sources: 's', draft: '' });
    expect(out.pass).toBe(true);
  });
});

describe('verifyDraft — failClosed (3.1)', () => {
  it('DEFAULT is fail-OPEN: a broken judge ships the claim (pass:true) — documents the hole', async () => {
    // extract → 1 claim; strict + permissive judge → garbage (no parse) → fail-open supported:true.
    const model = scriptedModel(['The company was founded in Berlin', 'garbage prose', 'garbage prose']);
    const out = await verifyDraft(model, { sources: 'The company is based in Munich.', draft: 'x' });
    expect(out.pass).toBe(true); // the pre-3.1 fail-open default
  });

  it('failClosed: a broken JUDGE → pass:false (closes the fail-open ship hole)', async () => {
    const model = scriptedModel(['The company was founded in Berlin', 'garbage prose', 'garbage prose']);
    const out = await verifyDraft(
      model,
      { sources: 'The company is based in Munich.', draft: 'x' },
      { failClosed: true },
    );
    expect(out.pass).toBe(false); // a judge we could not run cannot clear the claim
    expect(out.approvedCitations).toEqual([]);
  });

  it('failClosed: a claim-extractor failure → pass:false (not a spurious auto-pass)', async () => {
    const model: ChatModel = { chat: async () => { throw new Error('extractor down'); } };
    const out = await verifyDraft(model, { sources: 's', draft: 'The limit is 5%.' }, { failClosed: true });
    expect(out.pass).toBe(false);
    expect(out.critique).toContain('extraction failed');
  });

  it('failClosed: a genuinely claim-free draft (NONE) STILL passes — a greeting is not fabrication', async () => {
    const model = scriptedModel(['NONE']);
    const out = await verifyDraft(model, { sources: 's', draft: 'Hello!' }, { failClosed: true });
    expect(out.pass).toBe(true); // deliberate: failClosed hardens infra failures, not legitimate empties
  });

  it('failClosed: a draft with MORE claims than maxClaims → pass:false (too dense to fully verify)', async () => {
    // 10 claims but maxClaims=8 → 2 would be dropped-and-unverified → must not pass.
    const many = Array.from({ length: 10 }, (_, i) => `claim number ${i} is a real factual assertion`).join('\n');
    const out = await verifyDraft(scriptedModel([many]), { sources: 's', draft: 'x' }, { maxClaims: 8, failClosed: true });
    expect(out.pass).toBe(false);
    expect(out.critique).toContain('exceeds maxClaims'); // the exact overflow signal (non-vacuous)
  });
});

describe('verifyDraft — URL pre-pass', () => {
  it('auto-passes claims about allowlisted URLs without calling the judge', async () => {
    let judgeCalls = 0;
    const model: ChatModel = {
      chat: async ({ system }) => {
        if (system.includes('judge')) judgeCalls++;
        if (system.includes('extract atomic')) {
          return textResponse('Open a ticket in the official Discord at discord.gg/abc');
        }
        judgeCalls++;
        return textResponse('[1] SUPPORTED');
      },
    };
    const out = await verifyDraft(
      model,
      { sources: 's', draft: 'd' },
      { allowedUrlPatterns: ['discord.gg/abc'] },
    );
    expect(out.pass).toBe(true);
    expect(judgeCalls).toBe(0);
    // Pin that a claim WAS extracted and auto-passed — a regression yielding ZERO
    // claims would make pass=true, judgeCalls=0, AND `.every()` vacuously true.
    expect(out.verdicts).toHaveLength(1);
    expect(out.verdicts[0]!.supported).toBe(true);
  });

  it('still judges non-URL claims when a mix exists', async () => {
    const calls: string[] = [];
    const model: ChatModel = {
      chat: async (req) => {
        const { system } = req;
        if (system.includes('extract atomic')) {
          return textResponse('discord.gg/abc is the ticket channel\nThe price is $500');
        }
        calls.push(system.slice(0, 20));
        const user = reqUserText(req);
        const claimLines = (user.split('CLAIMS:\n')[1] ?? '').split('\n').filter(Boolean);
        return textResponse(claimLines.map((_, i) => `[${i + 1}] SUPPORTED`).join('\n'));
      },
    };
    const out = await verifyDraft(
      model,
      { sources: 'price is $500', draft: 'd' },
      { allowedUrlPatterns: ['discord.gg/abc'] },
    );
    expect(out.pass).toBe(true);
    // Only the price claim should have been judged
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('verifyDraft — strict + permissive flow', () => {
  it('passes when strict judge approves everything', async () => {
    const model: ChatModel = {
      chat: async ({ system }) => {
        if (system.includes('extract atomic')) return textResponse('claim A\nclaim B');
        return textResponse('[1] SUPPORTED\n[2] SUPPORTED');
      },
    };
    const out = await verifyDraft(model, { sources: 's', draft: 'd' });
    expect(out.pass).toBe(true);
  });

  it('rescues a claim when permissive judge accepts it after strict refusal', async () => {
    const replies = [
      'first claim with content',                        // extract
      '[1] UNSUPPORTED: phrasing diff', // strict
      '[1] SUPPORTED',                  // permissive rescues
    ];
    const model = scriptedModel(replies);
    const out = await verifyDraft(model, { sources: 's', draft: 'd' });
    expect(out.pass).toBe(true);
  });

  it('fails when both strict and permissive disagree', async () => {
    const replies = [
      'first claim with content',                  // extract
      '[1] UNSUPPORTED: invented',// strict
      '[1] UNSUPPORTED: invented',// permissive
    ];
    const model = scriptedModel(replies);
    const out = await verifyDraft(model, { sources: 's', draft: 'd' });
    expect(out.pass).toBe(false);
    expect(out.critique).toContain('Unsupported claim');
    expect(out.critique).toContain('first claim with content');
  });

  it('multi-claim critique formats with semicolons', async () => {
    const replies = [
      'first claim with content\nsecond claim with content', // extract
      '[1] UNSUPPORTED: a-bad\n[2] UNSUPPORTED: b-bad',       // strict
      '[1] UNSUPPORTED: a-bad\n[2] UNSUPPORTED: b-bad',       // permissive
    ];
    const out = await verifyDraft(scriptedModel(replies), { sources: 's', draft: 'd' });
    expect(out.pass).toBe(false);
    expect(out.critique).toContain('first claim with content');
    expect(out.critique).toContain('second claim with content');
    expect(out.critique).toContain(';');
  });

  it('approvedCitations is empty on FAIL', async () => {
    const replies = [
      'first claim with content',
      '[1] UNSUPPORTED: x',
      '[1] UNSUPPORTED: x',
    ];
    const out = await verifyDraft(scriptedModel(replies), { sources: 's', draft: 'd' });
    expect(out.approvedCitations).toEqual([]);
  });
});

describe('verifyDraft — citation building', () => {
  it('attaches citations from sourceRecords when claim text matches a source', async () => {
    const replies = ['the answer to question seven is forty two', '[1] SUPPORTED'];
    const out = await verifyDraft(scriptedModel(replies), {
      sources: 'the answer to question seven is forty two per the manual',
      draft: 'Q7 answer is 42.',
      sourceRecords: [
        {
          id: 'src-1',
          uri: 'https://example.com/manual',
          text: 'the answer to question seven is forty two per the manual',
          confidence: 0.95,
        },
      ],
    });
    expect(out.pass).toBe(true);
    expect(out.approvedCitations).toHaveLength(1);
    expect(out.approvedCitations[0]!.sourceId).toBe('src-1');
  });

  it('returns empty citations when no sourceRecords provided', async () => {
    const replies = ['claim X', '[1] SUPPORTED'];
    const out = await verifyDraft(scriptedModel(replies), {
      sources: 'something',
      draft: 'd',
    });
    expect(out.approvedCitations).toEqual([]);
  });

  it('does not attach a citation when no source backs the claim text', async () => {
    const replies = ['totally unrelated claim text here', '[1] SUPPORTED'];
    const out = await verifyDraft(scriptedModel(replies), {
      sources: 'unrelated source content',
      draft: 'd',
      sourceRecords: [
        { id: 'src-1', uri: 'x', text: 'completely different topic', confidence: 1 },
      ],
    });
    expect(out.approvedCitations).toEqual([]);
  });
});

describe('verifyDraft — model failure modes', () => {
  it('passes vacuously when extractor errors (fail-open by spec)', async () => {
    const model: ChatModel = {
      chat: async () => {
        throw new Error('extractor down');
      },
    };
    const out = await verifyDraft(model, { sources: 's', draft: 'd' });
    expect(out.pass).toBe(true);
    expect(out.verdicts).toEqual([]);
  });

  it('passes when judge errors mid-pipeline (fail-open)', async () => {
    let call = 0;
    const model: ChatModel = {
      chat: async () => {
        call++;
        if (call === 1) return textResponse('real claim with content');
        throw new Error('judge died');
      },
    };
    const out = await verifyDraft(model, { sources: 's', draft: 'd' });
    expect(out.pass).toBe(true);
  });
});
