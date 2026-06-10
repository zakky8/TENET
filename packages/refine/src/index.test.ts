import {
  knowledgeBoundaryGate,
  repairDraft,
  bestOfN,
  selfConsistency,
  type VerifyFn,
  type VerifyResultLike,
} from './index.js';

function pass(claims: Array<[string, boolean]> = []): VerifyResultLike {
  const verdicts = claims.map(([claim, supported]) => ({ claim, supported, reason: '' }));
  const failed = verdicts.filter((v) => !v.supported);
  return {
    pass: failed.length === 0,
    critique: failed.map((v) => `Unsupported claim: "${v.claim}"`).join('; '),
    verdicts,
  };
}

describe('knowledgeBoundaryGate', () => {
  it('blocks when too few hits', () => {
    const d = knowledgeBoundaryGate([], { minHits: 1 });
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/0 source/);
  });

  it('blocks when top score is below threshold', () => {
    const d = knowledgeBoundaryGate([{ score: 0.2 }, { score: 0.1 }], { minTopScore: 0.5 });
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/top retrieval score/);
  });

  it('blocks when total score is below threshold', () => {
    const d = knowledgeBoundaryGate([{ score: 0.3 }, { score: 0.3 }], { minTotalScore: 1.0 });
    expect(d.proceed).toBe(false);
  });

  it('proceeds when coverage is sufficient', () => {
    const d = knowledgeBoundaryGate([{ score: 2.5 }, { score: 1.1 }], {
      minHits: 2, minTopScore: 2.0, minTotalScore: 3.0,
    });
    expect(d.proceed).toBe(true);
  });

  it('defaults allow any non-empty hit list', () => {
    expect(knowledgeBoundaryGate([{ score: 0.0001 }]).proceed).toBe(true);
  });
});

describe('repairDraft', () => {
  it('returns immediately when the first verification passes', async () => {
    let rewrites = 0;
    const out = await repairDraft(
      'good draft',
      async () => pass([['claim', true]]),
      async () => { rewrites++; return 'never'; },
    );
    expect(out).toMatchObject({ draft: 'good draft', rounds: 0, repaired: false });
    expect(out.result.pass).toBe(true);
    expect(rewrites).toBe(0);
  });

  it('repairs a failing draft using the critique, then passes', async () => {
    const verify: VerifyFn = async (draft) =>
      draft.includes('$499')
        ? pass([['costs $499', false], ['ships free', true]])
        : pass([['ships free', true]]);
    const rewrite = async ({ draft, critique }: { draft: string; critique: string }): Promise<string> => {
      expect(critique).toContain('$499'); // critique reaches the rewriter
      return draft.replace(' Costs $499.', '');
    };
    const out = await repairDraft('Ships free. Costs $499.', verify, rewrite);
    expect(out.repaired).toBe(true);
    expect(out.rounds).toBe(1);
    expect(out.result.pass).toBe(true);
    expect(out.draft).toBe('Ships free.');
  });

  it('gives up after maxRounds and returns the failing diagnostics', async () => {
    let rewrites = 0;
    const out = await repairDraft(
      'bad',
      async () => pass([['wrong', false]]),
      async () => { rewrites++; return 'still bad'; },
      { maxRounds: 2 },
    );
    expect(rewrites).toBe(2);
    expect(out.result.pass).toBe(false);
    expect(out.repaired).toBe(false);
    expect(out.rounds).toBe(2);
  });

  it('maxRounds 0 = verify-only', async () => {
    const out = await repairDraft('x', async () => pass([['c', false]]), async () => 'y', { maxRounds: 0 });
    expect(out.rounds).toBe(0);
    expect(out.result.pass).toBe(false);
  });

  it('abort stops the loop', async () => {
    const ctrl = new AbortController();
    let rewrites = 0;
    const out = await repairDraft(
      'bad',
      async () => { return pass([['wrong', false]]); },
      async () => { rewrites++; ctrl.abort(); return 'still bad'; },
      { maxRounds: 5, signal: ctrl.signal },
    );
    // First rewrite runs, abort flips, loop exits before further rounds.
    expect(rewrites).toBe(1);
    expect(out.result.pass).toBe(false);
  });
});

describe('bestOfN', () => {
  it('picks the draft with the highest supported-claim ratio', async () => {
    const verify: VerifyFn = async (draft) => {
      if (draft === 'A') return pass([['a1', true], ['a2', false]]);   // 0.5
      if (draft === 'B') return pass([['b1', true], ['b2', true]]);    // 1.0
      return pass([['c1', false]]);                                    // 0.0
    };
    const out = await bestOfN(
      [async () => 'A', async () => 'B', async () => 'C'],
      verify,
    );
    expect(out.best.draft).toBe('B');
    expect(out.best.supportRatio).toBe(1);
    expect(out.all).toHaveLength(3);
    expect(out.all.map((s) => s.index)).toEqual([0, 1, 2]); // input order kept
  });

  it('tie on ratio → passing beats failing; then richer answer wins', async () => {
    const verify: VerifyFn = async (draft) => {
      if (draft === 'short') return pass([['s1', true]]);                 // ratio 1, 1 claim
      return pass([['l1', true], ['l2', true], ['l3', true]]);           // ratio 1, 3 claims
    };
    const out = await bestOfN([async () => 'short', async () => 'long'], verify);
    expect(out.best.draft).toBe('long');
  });

  it('claim-free passing draft scores 1, failing scores 0', async () => {
    const verify: VerifyFn = async (draft) =>
      draft === 'empty-pass' ? pass([]) : { pass: false, critique: 'x', verdicts: [] };
    const out = await bestOfN([async () => 'empty-fail', async () => 'empty-pass'], verify);
    expect(out.best.draft).toBe('empty-pass');
  });

  it('rejects an empty draft list', async () => {
    await expect(bestOfN([], async () => pass())).rejects.toThrow(/at least one/);
  });
});

describe('selfConsistency', () => {
  it('stable claims supported everywhere; unstable flip across samples', () => {
    const report = selfConsistency([
      [{ claim: 'The sky is blue.', supported: true, reason: '' },
       { claim: 'Founded in 1850', supported: true, reason: '' }],
      [{ claim: 'The sky is blue!', supported: true, reason: '' },
       { claim: 'founded in 1850', supported: false, reason: '' }],
    ]);
    expect(report.stable).toEqual(['The sky is blue.']);
    expect(report.unstable).toEqual(['Founded in 1850']);
    expect(report.fractions.get('Founded in 1850')).toBe(0.5);
  });

  it('punctuation/case differences match as the same claim', () => {
    const report = selfConsistency([
      [{ claim: 'Pricing starts at TIER ONE', supported: true, reason: '' }],
      [{ claim: 'pricing starts at tier one.', supported: true, reason: '' }],
    ]);
    expect(report.stable).toHaveLength(1);
    expect(report.fractions.size).toBe(1);
  });

  it('threshold relaxes the stability bar', () => {
    const sets = [
      [{ claim: 'x', supported: true, reason: '' }],
      [{ claim: 'x', supported: true, reason: '' }],
      [{ claim: 'x', supported: false, reason: '' }],
    ];
    expect(selfConsistency(sets).unstable).toEqual(['x']);            // default 1.0
    expect(selfConsistency(sets, { threshold: 0.6 }).stable).toEqual(['x']); // 2/3 ok
  });

  it('validates threshold', () => {
    expect(() => selfConsistency([], { threshold: 0 })).toThrow();
    expect(() => selfConsistency([], { threshold: 1.5 })).toThrow();
  });
});
