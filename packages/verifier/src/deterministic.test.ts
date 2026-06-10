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

  it('expands spelled magnitudes so 1.2M matches 1.2 million', () => {
    expect(extractNumericValues('raised $1.2 million last year')).toEqual([1_200_000]);
    expect(extractNumericValues('a 3.5bn valuation')).toEqual([3_500_000_000]);
  });

  it('masks dates, times, and ranges (structural, not standalone facts)', () => {
    expect(extractNumericValues('released 2025-01-15')).toEqual([]);
    expect(extractNumericValues('opens at 3:30pm')).toEqual([]);
    expect(extractNumericValues('priced $1-2M')).toEqual([]);
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

  it('fails a marked (%) number absent from sources', () => {
    const c = numericFabricationCheck();
    const r = c.check('Revenue grew 47% in 2025', sources);
    expect(r.verdict).toBe('fail');
    expect(r.reason).toContain('47');
  });

  it('DEFERS bare numbers by default — kills the false-fail families (audit H2)', () => {
    const c = numericFabricationCheck();
    // word-number paraphrase, dates, ranges, version numbers, counts:
    expect(c.check('refunds take 14 days', 'refunds take two weeks').verdict).toBe('judge');
    expect(c.check('released 2025-01-15', 'released January 15, 2025').verdict).toBe('judge');
    expect(c.check('we have 9 regions', 'nine regions worldwide').verdict).toBe('judge');
  });

  it('does NOT false-fail $1.2M against "$1.2 million" (spelled magnitude)', () => {
    const c = numericFabricationCheck();
    expect(c.check('we raised $1.2M', 'we raised $1.2 million in funding').verdict).toBe('judge');
  });

  it('matches across formats: $1,200,000 claim vs $1.2M source', () => {
    const c = numericFabricationCheck();
    expect(c.check('costs $1,200,000', 'priced at $1.2M').verdict).toBe('judge');
  });

  it('failBareNumbers opts into failing unmarked values', () => {
    const c = numericFabricationCheck({ failBareNumbers: true });
    expect(c.check('exactly 7 steps', 'there are 4 steps').verdict).toBe('fail');
  });

  it('relativeTolerance lets rounded marked values match', () => {
    const exact = numericFabricationCheck({ failBareNumbers: true });
    const loose = numericFabricationCheck({ relativeTolerance: 0.005, failBareNumbers: true });
    expect(exact.check('pi is 3.14', 'pi is 3.14159').verdict).toBe('fail');
    expect(loose.check('pi is 3.14', 'pi is 3.14159').verdict).toBe('judge');
  });

  it('rejects negative tolerance', () => {
    expect(() => numericFabricationCheck({ relativeTolerance: -1 })).toThrow();
  });
});

describe('quoteGroundingCheck', () => {
  const QUOTE = 'refunds are processed within 14 business days of approval';
  const sources = `The policy states: "${QUOTE}". Contact support for exceptions.`;

  it('passes a claim that IS the verbatim quote (inert residue)', () => {
    const c = quoteGroundingCheck();
    expect(c.check(`"${QUOTE}."`, sources).verdict).toBe('pass');
  });

  it('normalizes curly double-quotes and whitespace', () => {
    const c = quoteGroundingCheck();
    expect(c.check(`“refunds are  processed within 14 business days of approval”`, sources).verdict).toBe('pass');
  });

  // Fable audit H1 — the residue outside the quote must be inert; any
  // negation / misattribution / extension defers to the judges.
  it('DEFERS a negated quote (audit H1)', () => {
    const c = quoteGroundingCheck();
    expect(c.check(`It is false that "${QUOTE}"`, sources).verdict).toBe('judge');
  });

  it('DEFERS a misattributed quote (audit H1)', () => {
    const c = quoteGroundingCheck();
    expect(c.check(`CompetitorX says "${QUOTE}"`, sources).verdict).toBe('judge');
  });

  it('DEFERS a quote extended with a fabricated clause (audit H1)', () => {
    const c = quoteGroundingCheck();
    expect(c.check(`"${QUOTE}" for 99% of enterprise users`, sources).verdict).toBe('judge');
  });

  it('defers when the quote is not in sources', () => {
    const c = quoteGroundingCheck();
    expect(c.check('"refunds are instant and unconditional for everyone"', sources).verdict).toBe('judge');
  });

  it('defers a too-short quote', () => {
    const c = quoteGroundingCheck();
    expect(c.check('"refunds"', sources).verdict).toBe('judge');
  });

  // Fable audit M3 — apostrophes must not be treated as quote delimiters.
  it('does not manufacture a quote span from apostrophes (audit M3)', () => {
    const c = quoteGroundingCheck();
    const claim = `Acme's refunds are processed within 14 business days of approval per policy's terms`;
    expect(c.check(claim, sources).verdict).toBe('judge');
  });

  it('validates options', () => {
    expect(() => quoteGroundingCheck({ minQuoteChars: 0 })).toThrow();
    expect(() => quoteGroundingCheck({ maxResidueChars: -1 })).toThrow();
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
