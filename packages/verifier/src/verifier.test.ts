import { verifyDraft } from './verifier.js';
import type { ChatModel } from './types.js';

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
      return r;
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

describe('verifyDraft — URL pre-pass', () => {
  it('auto-passes claims about allowlisted URLs without calling the judge', async () => {
    let judgeCalls = 0;
    const model: ChatModel = {
      chat: async ({ system }) => {
        if (system.includes('judge')) judgeCalls++;
        if (system.includes('extract atomic')) {
          return 'Open a ticket in the official Discord at discord.gg/abc';
        }
        judgeCalls++;
        return '[1] SUPPORTED';
      },
    };
    const out = await verifyDraft(
      model,
      { sources: 's', draft: 'd' },
      { allowedUrlPatterns: ['discord.gg/abc'] },
    );
    expect(out.pass).toBe(true);
    expect(judgeCalls).toBe(0);
    expect(out.verdicts.every((v) => v.supported)).toBe(true);
  });

  it('still judges non-URL claims when a mix exists', async () => {
    const calls: string[] = [];
    const model: ChatModel = {
      chat: async ({ system, user }) => {
        if (system.includes('extract atomic')) {
          return 'discord.gg/abc is the ticket channel\nThe price is $500';
        }
        calls.push(system.slice(0, 20));
        const claimLines = (user.split('CLAIMS:\n')[1] ?? '').split('\n').filter(Boolean);
        return claimLines.map((_, i) => `[${i + 1}] SUPPORTED`).join('\n');
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
        if (system.includes('extract atomic')) return 'claim A\nclaim B';
        return '[1] SUPPORTED\n[2] SUPPORTED';
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
    const replies = ['LITE node costs $500', '[1] SUPPORTED'];
    const out = await verifyDraft(scriptedModel(replies), {
      sources: 'LITE node costs $500 and includes 1,333 AST',
      draft: 'The LITE node is $500.',
      sourceRecords: [
        {
          id: 'src-1',
          uri: 'https://example.com/nodes',
          text: 'LITE node costs $500 and includes 1,333 AST',
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
        if (call === 1) return 'real claim with content';
        throw new Error('judge died');
      },
    };
    const out = await verifyDraft(model, { sources: 's', draft: 'd' });
    expect(out.pass).toBe(true);
  });
});
