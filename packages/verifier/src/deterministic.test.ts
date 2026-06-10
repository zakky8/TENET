import {
  extractNumericValues,
  numericFabricationCheck,
  quoteGroundingCheck,
  defaultPreChecks,
  runPreChecks,
} from './deterministic.js';
import { verifyDraft } from './verifier.js';
import type { ChatModel } from './types.js';

describe('extractNumericValues', () => {
  it('parses plain ints, decimals, thousands separators', () => {
    expect(extractNumericValues('we sold 1,250 units at 3.5 each')).toEqual([1250, 3.5]);
  });

  it('expands magnitude suffixes k/M/B', () => {
    expect(extractNumericValues('raised $1.2M from 5k users')).toEqual([1_200_000, 5_000]);
  });

  it('treats % as the bare value', () => {
    expect(extractNumericValues('growth was 12%')).toEqual([12]);
  });

  it('ignores numbers embedded in identifiers', () => {
    // sha256's digits are glued to letters → rejected by the lookbehind;
    // HHEM-2.1's version number follows a hyphen → extracted (it IS a
    // number a claim could fabricate).
    expect(extractNumericValues('see HHEM-2.1 and sha256 digests')).toEqual([2.1]);
  });

  it('returns empty for no numbers', () => {
    expect(extractNumericValues('no digits here')).toEqual([]);
  });
});

describe('numericFabricationCheck', () => {
  const sources = 'Revenue grew 12% to $1.2M in 2025 across 1,250 customers.';

  it('defers when the claim has no numbers', () => {
    const c = numericFabricationCheck();
    expect(c.check('revenue grew strongly', sources).verdict).toBe('judge');
  });

  it('defers when all claim numbers appear in sources (presence ≠ support)', () => {
    const c = numericFabricationCheck();
    expect(c.check('Revenue grew 12% in 2025', sources).verdict).toBe('judge');
  });

  it('fails when a claim number appears nowhere in sources', () => {
    const c = numericFabricationCheck();
    const r = c.check('Revenue grew 47% in 2025', sources);
    expect(r.verdict).toBe('fail');
    expect(r.reason).toContain('47');
  });

  it('matches across formats: 1.2M claim vs 1,200,000 source', () => {
    const c = numericFabricationCheck();
    expect(c.check('about 1,200,000 dollars', 'we raised $1.2M').verdict).toBe('judge');
  });

  it('relativeTolerance lets rounded values match', () => {
    const exact = numericFabricationCheck();
    const loose = numericFabricationCheck({ relativeTolerance: 0.005 });
    expect(exact.check('pi is 3.14', 'pi is 3.14159').verdict).toBe('fail');
    expect(loose.check('pi is 3.14', 'pi is 3.14159').verdict).toBe('judge');
  });

  it('rejects negative tolerance', () => {
    expect(() => numericFabricationCheck({ relativeTolerance: -1 })).toThrow();
  });
});

describe('quoteGroundingCheck', () => {
  const sources = 'The policy states: refunds are processed within 14 business days of approval.';

  it('passes a claim that is essentially a verbatim source quote', () => {
    const c = quoteGroundingCheck();
    const r = c.check('The policy says "refunds are processed within 14 business days of approval."', sources);
    expect(r.verdict).toBe('pass');
  });

  it('normalizes curly quotes and whitespace', () => {
    const c = quoteGroundingCheck();
    const r = c.check('Per docs: “refunds are  processed within 14 business days of approval”', sources);
    expect(r.verdict).toBe('pass');
  });

  it('defers when the quote is not in sources', () => {
    const c = quoteGroundingCheck();
    expect(c.check('"refunds are instant and unconditional for everyone"', sources).verdict).toBe('judge');
  });

  it('defers when the quote is too short or low-coverage', () => {
    const c = quoteGroundingCheck();
    // short quote
    expect(c.check('"refunds" happen sometimes maybe', sources).verdict).toBe('judge');
    // real quote buried in a long fabricated claim (coverage < 0.6)
    const padded = `Because our CEO personally guarantees same-day payouts to every user worldwide regardless of status, and "refunds are processed within 14 business days of approval" only applies to enterprise contracts signed before 2020`;
    expect(c.check(padded, sources).verdict).toBe('judge');
  });

  it('validates options', () => {
    expect(() => quoteGroundingCheck({ minQuoteChars: 0 })).toThrow();
    expect(() => quoteGroundingCheck({ minCoverage: 1.5 })).toThrow();
  });
});

describe('runPreChecks composition', () => {
  it('first non-judge verdict wins; quote pass beats numeric fail', () => {
    const sources = 'The report says: "the fund returned 8% over five years against a 12% benchmark."';
    const claim = '"the fund returned 8% over five years against a 12% benchmark."';
    const r = runPreChecks(defaultPreChecks(), claim, sources);
    expect(r.verdict).toBe('pass');
  });

  it('all-judge defers', () => {
    const r = runPreChecks(defaultPreChecks(), 'a vague statement', 'unrelated sources');
    expect(r.verdict).toBe('judge');
  });
});

describe('verifyDraft with claimPreChecks (integration)', () => {
  function modelScript(opts: { extract: string; judgeReply?: string }): { model: ChatModel; judgeCalls: () => number } {
    let judges = 0;
    const model: ChatModel = {
      chat: async ({ system }) => {
        if (system.includes('extract atomic')) return opts.extract;
        judges++;
        return opts.judgeReply ?? '[1] SUPPORTED';
      },
    };
    return { model, judgeCalls: () => judges };
  }

  it('deterministic numeric fail rejects the draft with ZERO judge calls', async () => {
    const { model, judgeCalls } = modelScript({ extract: 'The product costs $499.' });
    const out = await verifyDraft(model, {
      sources: 'The product costs $299 with free shipping.',
      draft: 'The product costs $499.',
    }, { claimPreChecks: defaultPreChecks() });

    expect(out.pass).toBe(false);
    expect(judgeCalls()).toBe(0); // strict AND permissive both skipped
    expect(out.verdicts[0]!.reason).toMatch(/deterministic.*499/);
    expect(out.approvedCitations).toEqual([]);
  });

  it('deterministic quote pass approves with zero judge calls', async () => {
    const sources = 'Support hours: "we answer tickets within one business day, monday to friday."';
    const { model, judgeCalls } = modelScript({
      extract: '"we answer tickets within one business day, monday to friday."',
    });
    const out = await verifyDraft(model, { sources, draft: 'x' }, { claimPreChecks: defaultPreChecks() });
    expect(out.pass).toBe(true);
    expect(judgeCalls()).toBe(0);
    expect(out.verdicts[0]!.reason).toMatch(/verbatim-grounded/);
  });

  it('mixed: judged claims pass but a deterministic fail still sinks the draft', async () => {
    const { model } = modelScript({
      extract: 'The service is reliable.\nThe uptime was 87.3% last year.',
      judgeReply: '[1] SUPPORTED',
    });
    const out = await verifyDraft(model, {
      sources: 'Our service had 99.99 percent uptime according to the status page.',
      draft: 'x',
    }, { claimPreChecks: defaultPreChecks() });
    expect(out.pass).toBe(false);
    const det = out.verdicts.find((v) => v.reason.startsWith('deterministic'));
    expect(det?.supported).toBe(false);
    expect(det?.reason).toContain('87.3');
  });

  it('without claimPreChecks behaviour is unchanged (backwards compat)', async () => {
    const { model, judgeCalls } = modelScript({ extract: 'The product costs $499.' });
    const out = await verifyDraft(model, {
      sources: 'The product costs $299.',
      draft: 'The product costs $499.',
    });
    expect(judgeCalls()).toBeGreaterThan(0); // judges DID run
    expect(out.pass).toBe(true); // scripted judge says SUPPORTED — the exact
    // wrong-number case LLM judges wave through and the new tier catches
  });
});
