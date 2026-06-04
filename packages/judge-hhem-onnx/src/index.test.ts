import { OnnxHhemScorer, sigmoid, type OnnxPipeline } from './index.js';

const constantPipeline = (v: number): OnnxPipeline => ({ async score() { return v; } });

describe('OnnxHhemScorer', () => {
  it('passes through a probability score', async () => {
    const s = new OnnxHhemScorer({ pipeline: constantPipeline(0.8) });
    expect(await s.score({ premise: 'p', hypothesis: 'h' })).toBe(0.8);
  });

  it('rescales with the supplied function', async () => {
    const s = new OnnxHhemScorer({
      pipeline: constantPipeline(2.0),
      rescale: sigmoid,
    });
    const r = await s.score({ premise: 'p', hypothesis: 'h' });
    expect(r).toBeCloseTo(sigmoid(2.0), 5);
  });

  it('clamps above-1 results to 1', async () => {
    const s = new OnnxHhemScorer({ pipeline: constantPipeline(1.7) });
    expect(await s.score({ premise: 'p', hypothesis: 'h' })).toBe(1);
  });

  it('clamps below-0 results to 0', async () => {
    const s = new OnnxHhemScorer({ pipeline: constantPipeline(-0.4) });
    expect(await s.score({ premise: 'p', hypothesis: 'h' })).toBe(0);
  });

  it('throws on non-finite pipeline output', async () => {
    const s = new OnnxHhemScorer({ pipeline: constantPipeline(Number.NaN) });
    await expect(s.score({ premise: 'p', hypothesis: 'h' })).rejects.toThrow();
  });

  it('exposes modelId when set', () => {
    const s = new OnnxHhemScorer({
      pipeline: constantPipeline(1),
      modelId: 'vectara/hhem-2.1-open',
    });
    expect(s.modelId).toBe('vectara/hhem-2.1-open');
  });

  it('propagates signal through to the pipeline', async () => {
    const captured: Array<AbortSignal | undefined> = [];
    const pipe: OnnxPipeline = {
      async score(args) {
        captured.push(args.signal);
        return 1;
      },
    };
    const s = new OnnxHhemScorer({ pipeline: pipe });
    const ctrl = new AbortController();
    await s.score({ premise: 'p', hypothesis: 'h', signal: ctrl.signal });
    expect(captured[0]).toBe(ctrl.signal);
  });
});

describe('sigmoid', () => {
  it('=0.5 at 0', () => expect(sigmoid(0)).toBeCloseTo(0.5, 5));
  it('→1 at large positive', () => expect(sigmoid(50)).toBeCloseTo(1, 5));
  it('→0 at large negative', () => expect(sigmoid(-50)).toBeCloseTo(0, 5));
});
