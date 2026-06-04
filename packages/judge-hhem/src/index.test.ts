import { HhemJudge, HhemJudgeError, TOKEN_OVERLAP_SCORER, type HhemScorer, type AtomicClaim } from './index.js';

const claim = (id: string, premise: string, hypothesis: string): AtomicClaim => ({
  caseId: `c-${id}`,
  claimId: id,
  premise,
  hypothesis,
});

describe('HhemJudge — construction', () => {
  it('rejects threshold outside [0,1]', () => {
    expect(() => new HhemJudge(TOKEN_OVERLAP_SCORER, { threshold: 1.5 })).toThrow(HhemJudgeError);
    expect(() => new HhemJudge(TOKEN_OVERLAP_SCORER, { threshold: -0.1 })).toThrow(HhemJudgeError);
  });

  it('accepts threshold at boundaries', () => {
    expect(() => new HhemJudge(TOKEN_OVERLAP_SCORER, { threshold: 0 })).not.toThrow();
    expect(() => new HhemJudge(TOKEN_OVERLAP_SCORER, { threshold: 1 })).not.toThrow();
  });
});

describe('HhemJudge.judge', () => {
  it('supported = true when score >= threshold', async () => {
    const j = new HhemJudge(TOKEN_OVERLAP_SCORER, { threshold: 0.5 });
    const v = await j.judge(claim('a', 'paris is the capital of france', 'paris france'));
    expect(v.supported).toBe(true);
    expect(v.score).toBe(1);
  });

  it('supported = false when score < threshold', async () => {
    const j = new HhemJudge(TOKEN_OVERLAP_SCORER, { threshold: 0.5 });
    const v = await j.judge(claim('b', 'paris is the capital of france', 'tokyo japan'));
    expect(v.supported).toBe(false);
    expect(v.score).toBe(0);
  });

  it('threshold boundary — score exactly == threshold is supported', async () => {
    const constant: HhemScorer = { async score() { return 0.5; } };
    const j = new HhemJudge(constant, { threshold: 0.5 });
    const v = await j.judge(claim('x', 'p', 'h'));
    expect(v.supported).toBe(true);
  });

  it('wraps scorer throw into HhemJudgeError', async () => {
    const bad: HhemScorer = { async score() { throw new Error('boom'); } };
    const j = new HhemJudge(bad, { threshold: 0.5 });
    await expect(j.judge(claim('x', 'p', 'h'))).rejects.toBeInstanceOf(HhemJudgeError);
  });

  it('rejects out-of-range scorer output as invalid_score', async () => {
    const bad: HhemScorer = { async score() { return 1.5; } };
    const j = new HhemJudge(bad, { threshold: 0.5 });
    await expect(j.judge(claim('x', 'p', 'h'))).rejects.toMatchObject({ code: 'invalid_score' });
  });

  it('rejects NaN scorer output', async () => {
    const bad: HhemScorer = { async score() { return Number.NaN; } };
    const j = new HhemJudge(bad, { threshold: 0.5 });
    await expect(j.judge(claim('x', 'p', 'h'))).rejects.toMatchObject({ code: 'invalid_score' });
  });

  it('passes signal through to scorer', async () => {
    const captured: Array<AbortSignal | undefined> = [];
    const watching: HhemScorer = {
      async score(args) {
        captured.push(args.signal);
        return 1;
      },
    };
    const j = new HhemJudge(watching, { threshold: 0.5 });
    const ctrl = new AbortController();
    await j.judge(claim('x', 'p', 'h'), ctrl.signal);
    expect(captured[0]).toBe(ctrl.signal);
  });
});

describe('HhemJudge.judgeAll', () => {
  it('returns verdicts in input order', async () => {
    const j = new HhemJudge(TOKEN_OVERLAP_SCORER, { threshold: 0.5 });
    const claims = [
      claim('1', 'cats are mammals', 'cats are mammals'),
      claim('2', 'dogs bark', 'fish swim'),
      claim('3', 'birds fly', 'birds fly'),
    ];
    const verdicts = await j.judgeAll(claims);
    expect(verdicts.map((v) => v.claimId)).toEqual(['1', '2', '3']);
    expect(verdicts[0]!.supported).toBe(true);
    expect(verdicts[1]!.supported).toBe(false);
    expect(verdicts[2]!.supported).toBe(true);
  });

  it('honors concurrency cap', async () => {
    let inflight = 0;
    let peak = 0;
    const slow: HhemScorer = {
      async score() {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
        return 1;
      },
    };
    const j = new HhemJudge(slow, { threshold: 0.5, concurrency: 2 });
    const claims = Array.from({ length: 10 }, (_, i) => claim(String(i), 'p', 'h'));
    await j.judgeAll(claims);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('TOKEN_OVERLAP_SCORER', () => {
  it('returns 1 for full overlap', async () => {
    expect(await TOKEN_OVERLAP_SCORER.score({ premise: 'a b c', hypothesis: 'a b' })).toBe(1);
  });

  it('returns 0 for no overlap', async () => {
    expect(await TOKEN_OVERLAP_SCORER.score({ premise: 'a b c', hypothesis: 'x y' })).toBe(0);
  });

  it('returns 1 for empty hypothesis (vacuous)', async () => {
    expect(await TOKEN_OVERLAP_SCORER.score({ premise: 'a b c', hypothesis: '' })).toBe(1);
  });
});
