import {
  sequential,
  parallel,
  branch,
  retry,
  withTimeout,
  runWorkflow,
  WorkflowError,
  type Step,
  type TraceEvent,
} from './index.js';

const numToStr: Step<number, string> = async (n) => String(n);
const strLen: Step<string, number> = async (s) => s.length;
const double: Step<number, number> = async (n) => n * 2;

describe('sequential', () => {
  it('pipes input through each step', async () => {
    const wf = sequential(double, numToStr, strLen);
    const result = await runWorkflow(wf, 50, { runId: 'r1' });
    expect(result).toBe(3); // 50→100→'100'→3
  });

  it('emits trace events per step', async () => {
    const events: TraceEvent[] = [];
    const wf = sequential(double, double);
    await runWorkflow(wf, 5, { runId: 'r1', trace: (e) => events.push(e) });
    const startCount = events.filter((e) => e.kind === 'step.start').length;
    const endCount = events.filter((e) => e.kind === 'step.end').length;
    expect(startCount).toBeGreaterThanOrEqual(2);
    expect(endCount).toBeGreaterThanOrEqual(2);
  });

  it('aborts mid-pipeline when signal fires', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const wf = sequential(double, double);
    await expect(runWorkflow(wf, 1, { runId: 'r', signal: ctrl.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
  });
});

describe('parallel', () => {
  it('runs steps concurrently, preserving order', async () => {
    const wf = parallel(double, double, double);
    const [a, b, c] = await runWorkflow(wf, 10, { runId: 'r' });
    expect([a, b, c]).toEqual([20, 20, 20]);
  });

  it('parallel_failed when one rejects + cancels siblings', async () => {
    let s2Aborted = false;
    const s1: Step<number, number> = async () => { throw new Error('boom'); };
    const s2: Step<number, number> = async (_, ctx) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 50);
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); s2Aborted = true; reject(new Error('aborted')); });
      });
      return 0;
    };
    const wf = parallel(s1, s2);
    await expect(runWorkflow(wf, 1, { runId: 'r' })).rejects.toMatchObject({ code: 'parallel_failed' });
    expect(s2Aborted).toBe(true);
  });
});

describe('branch', () => {
  it('picks ifTrue when predicate true', async () => {
    const t: Step<number, string> = async () => 'big';
    const f: Step<number, string> = async () => 'small';
    const wf = branch<number, string, string>((n) => n > 10, t, f);
    expect(await runWorkflow(wf, 100, { runId: 'r' })).toBe('big');
    expect(await runWorkflow(wf, 1, { runId: 'r' })).toBe('small');
  });

  it('honors async predicate', async () => {
    const t: Step<number, string> = async () => 't';
    const f: Step<number, string> = async () => 'f';
    const wf = branch<number, string, string>(async () => true, t, f);
    expect(await runWorkflow(wf, 0, { runId: 'r' })).toBe('t');
  });
});

describe('retry', () => {
  it('returns on first success', async () => {
    const ok: Step<number, number> = async (n) => n + 1;
    const wf = retry(ok, { maxAttempts: 3 });
    expect(await runWorkflow(wf, 5, { runId: 'r' })).toBe(6);
  });

  it('retries on throw + succeeds within budget', async () => {
    let calls = 0;
    const flaky: Step<number, number> = async (n) => {
      calls++;
      if (calls < 3) throw new Error('flake');
      return n;
    };
    const wf = retry(flaky, { maxAttempts: 5, initialDelayMs: 1 });
    expect(await runWorkflow(wf, 42, { runId: 'r' })).toBe(42);
    expect(calls).toBe(3);
  });

  it('retry_exhausted after maxAttempts', async () => {
    const always: Step<number, number> = async () => { throw new Error('nope'); };
    const wf = retry(always, { maxAttempts: 2, initialDelayMs: 1 });
    await expect(runWorkflow(wf, 1, { runId: 'r' })).rejects.toMatchObject({ code: 'retry_exhausted' });
  });

  it('shouldRetry filter respected', async () => {
    let calls = 0;
    const s: Step<number, number> = async () => { calls++; throw new Error('boom'); };
    const wf = retry(s, { maxAttempts: 5, initialDelayMs: 1, shouldRetry: () => false });
    await expect(runWorkflow(wf, 1, { runId: 'r' })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('withTimeout', () => {
  it('throws timeout on slow step', async () => {
    const slow: Step<number, number> = async (_, ctx) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 200);
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      });
      return 0;
    };
    const wf = withTimeout(slow, 20);
    await expect(runWorkflow(wf, 1, { runId: 'r' })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('passes through on fast step', async () => {
    const fast: Step<number, number> = async (n) => n;
    const wf = withTimeout(fast, 1000);
    expect(await runWorkflow(wf, 7, { runId: 'r' })).toBe(7);
  });

  it('re-throws a normal step error UNCHANGED — not masked as a timeout', async () => {
    // The wall-clock did not fire, so the original error must pass through so consumers
    // that inspect the error type (retryable? auth? abort?) still can. A regression that
    // wrapped every catch as WorkflowError('timeout') would break that.
    const boom: Step<number, number> = async () => { throw new Error('business failure'); };
    const wf = withTimeout(boom, 1000);
    await expect(runWorkflow(wf, 1, { runId: 'r' })).rejects.toThrow('business failure');
  });

  it('a PARENT abort re-throws the abort, NOT a timeout (caller-cancel ≠ wall-clock)', async () => {
    const ac = new AbortController();
    const slow: Step<number, number> = async (_, ctx) =>
      new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => resolve(0), 500);
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('caller cancelled')); });
      });
    const wf = withTimeout(slow, 1000); // generous budget — the CALLER's abort fires first
    const p = runWorkflow(wf, 1, { runId: 'r', signal: ac.signal });
    ac.abort();
    // Only the timeout controller firing → 'timeout'; a caller abort must surface as itself.
    await expect(p).rejects.toThrow('caller cancelled');
  });
});
