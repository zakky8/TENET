import { extractClaims } from './claimExtractor.js';
import { DEFAULT_VERIFIER_CONFIG, type ChatModel } from './types.js';

function mockModel(reply: string): ChatModel {
  return { chat: async () => reply };
}

describe('extractClaims — basic behavior', () => {
  it('parses one claim per line', async () => {
    const out = await extractClaims(
      mockModel('claim one is here\nclaim two is here'),
      'draft',
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out).toEqual(['claim one is here', 'claim two is here']);
  });

  it('returns [] on NONE sentinel', async () => {
    const out = await extractClaims(mockModel('NONE'), 'd', DEFAULT_VERIFIER_CONFIG);
    expect(out).toEqual([]);
  });

  it('returns [] on empty draft (no LLM call)', async () => {
    let called = 0;
    const model: ChatModel = { chat: async () => { called++; return 'x'; } };
    expect(await extractClaims(model, '', DEFAULT_VERIFIER_CONFIG)).toEqual([]);
    expect(called).toBe(0);
  });

  it('fail-open on extractor error (returns [])', async () => {
    const model: ChatModel = { chat: async () => { throw new Error('x'); } };
    const out = await extractClaims(model, 'd', DEFAULT_VERIFIER_CONFIG);
    expect(out).toEqual([]);
  });

  it('filters claims by length window (>=8, <=240)', async () => {
    // 'short' = 5 chars — dropped
    // long string > 240 — dropped
    const longClaim = 'x'.repeat(300);
    const out = await extractClaims(
      mockModel(`short\nmedium claim is here\n${longClaim}`),
      'd',
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out).toEqual(['medium claim is here']);
  });

  it('caps at config.maxClaims', async () => {
    const claims = Array.from({ length: 20 }, (_, i) => `claim number ${i} is valid`).join('\n');
    const out = await extractClaims(mockModel(claims), 'd', { ...DEFAULT_VERIFIER_CONFIG, maxClaims: 3 });
    expect(out).toHaveLength(3);
  });
});

describe('extractClaims — list-marker stripping (FIX #2 — leading digit preservation)', () => {
  it('strips numbered list "1. " prefix', async () => {
    const out = await extractClaims(
      mockModel('1. claim one text here\n2. claim two text here'),
      'd',
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out).toEqual(['claim one text here', 'claim two text here']);
  });

  it('strips numbered list "1) " prefix', async () => {
    const out = await extractClaims(mockModel('1) claim one text here'), 'd', DEFAULT_VERIFIER_CONFIG);
    expect(out).toEqual(['claim one text here']);
  });

  it('strips parens-numbered "(1) " prefix', async () => {
    const out = await extractClaims(mockModel('(1) claim text is here'), 'd', DEFAULT_VERIFIER_CONFIG);
    expect(out).toEqual(['claim text is here']);
  });

  it('strips dash bullet "- "', async () => {
    const out = await extractClaims(mockModel('- claim text is here'), 'd', DEFAULT_VERIFIER_CONFIG);
    expect(out).toEqual(['claim text is here']);
  });

  it('strips star bullet "* "', async () => {
    const out = await extractClaims(mockModel('* claim text is here'), 'd', DEFAULT_VERIFIER_CONFIG);
    expect(out).toEqual(['claim text is here']);
  });

  it('strips unicode bullet "• "', async () => {
    const out = await extractClaims(mockModel('• claim text is here'), 'd', DEFAULT_VERIFIER_CONFIG);
    expect(out).toEqual(['claim text is here']);
  });

  // REGRESSION FIXES — the old /^[\s\-•*\d.)]+/ would eat leading digits of
  // the claim itself. Locked in so this never regresses.

  it('REGRESSION: "2025 EU rule banned X" survives intact (leading year preserved)', async () => {
    const out = await extractClaims(
      mockModel('2025 EU rule banned the use of unverified data sources'),
      'd',
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out).toEqual(['2025 EU rule banned the use of unverified data sources']);
  });

  it('REGRESSION: "5000 units per shipment" survives — no leading-digit strip', async () => {
    const out = await extractClaims(mockModel('5000 units per shipment crate'), 'd', DEFAULT_VERIFIER_CONFIG);
    expect(out).toEqual(['5000 units per shipment crate']);
  });

  it('REGRESSION: "0.005 ETH gas fee per call" survives (leading decimal preserved)', async () => {
    const out = await extractClaims(
      mockModel('0.005 ETH gas fee per call is the baseline rate'),
      'd',
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out).toEqual(['0.005 ETH gas fee per call is the baseline rate']);
  });

  it('REGRESSION: "12,000 records in the dataset" survives (leading comma-number)', async () => {
    const out = await extractClaims(
      mockModel('12,000 records in the dataset are tagged'),
      'd',
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out).toEqual(['12,000 records in the dataset are tagged']);
  });

  it('does not strip "1.5%" because there is no following space (not a list marker)', async () => {
    const out = await extractClaims(mockModel('1.5% APY on staked tokens'), 'd', DEFAULT_VERIFIER_CONFIG);
    expect(out).toEqual(['1.5% APY on staked tokens']);
  });
});
