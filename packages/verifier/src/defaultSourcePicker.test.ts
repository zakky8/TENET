import type { Source } from '@tenet/core';
import { defaultSourcePicker } from './defaultSourcePicker.js';

function source(id: string, text: string, confidence = 0.9): Source {
  return { id, uri: `https://example.com/${id}`, text, confidence };
}

describe('defaultSourcePicker — stage 1: head substring', () => {
  it('returns the source whose text contains the claim head verbatim', () => {
    const c = defaultSourcePicker.pick(
      'the answer to question seven is forty two',
      [source('A', 'unrelated text about other topics'),
       source('B', 'in the manual the answer to question seven is forty two and more')],
    );
    expect(c?.sourceId).toBe('B');
  });

  it('quote is capped at QUOTE_LEN (240)', () => {
    const long = 'x'.repeat(1000);
    const c = defaultSourcePicker.pick('abc', [source('A', 'abc ' + long)]);
    expect(c!.quote.length).toBeLessThanOrEqual(240);
  });

  it('returns null when sources is empty', () => {
    expect(defaultSourcePicker.pick('claim x y z', [])).toBeNull();
  });
});

describe('defaultSourcePicker — stage 2: significant-token overlap', () => {
  it('rescues a paraphrased claim by ≥3 significant-token overlap', () => {
    const c = defaultSourcePicker.pick(
      'budget allocation favors operations and the security team this quarter',
      [
        source('A', 'this quarter the operations team gets a large budget allocation for security'),
      ],
    );
    expect(c?.sourceId).toBe('A');
  });

  it('requires ≥3 significant tokens — 2 overlap is not enough', () => {
    const c = defaultSourcePicker.pick(
      'budget allocation rules',
      [source('A', 'allocation policy for fiscal year')],
    );
    // overlap = "allocation" only = 1 < threshold
    expect(c).toBeNull();
  });

  it('ignores ≤3-char tokens (the/and/of) for the token-overlap stage', () => {
    // Distinct heads so stage 1 doesn't match; only ≤3-char tokens overlap.
    const c = defaultSourcePicker.pick(
      'the cat sat on the mat',
      [source('A', 'and the dog ran past')],
    );
    // Only 'the' overlaps (≤3 chars) — filtered out — no overlap counted
    expect(c).toBeNull();
  });
});

describe('defaultSourcePicker — REGRESSION (B1 fix)', () => {
  it('paraphrased claim is now attributed (was [])', () => {
    // Old impl head='lite node costs $500' would NOT be in source text 'price $500'
    // New impl catches via token overlap: node + price + tier + slot
    const c = defaultSourcePicker.pick(
      'the entry-level node tier costs five hundred dollars per slot',
      [source('A', 'entry-level node price: $500 per slot in the tier table')],
    );
    expect(c?.sourceId).toBe('A');
  });

  it('still returns null when source genuinely does not back the claim', () => {
    const c = defaultSourcePicker.pick(
      'mars has two moons named phobos and deimos',
      [source('A', 'the team meeting is scheduled for tuesday at three pm')],
    );
    expect(c).toBeNull();
  });
});
