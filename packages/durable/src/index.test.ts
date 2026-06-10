import {
  DurableRunner,
  InMemoryJournalStore,
  StateStoreJournal,
  NondeterminismError,
  type DurableCtx,
  type StateStoreLike,
} from './index.js';

describe('DurableRunner — step memoization', () => {
  it('completes and returns the value', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    const result = await runner.run('r1', async (ctx) => {
      const a = await ctx.step('a', () => 2);
      const b = await ctx.step('b', () => 3);
      return a + b;
    });
    expect(result).toEqual({ status: 'completed', value: 5 });
  });

  it('replay does NOT re-execute completed steps', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    let executions = 0;
    const fn = async (ctx: DurableCtx): Promise<number> =>
      ctx.step('expensive', () => { executions++; return 42; });
    await runner.run('r1', fn);
    await runner.run('r1', fn);
    await runner.run('r1', fn);
    expect(executions).toBe(1);
  });

  it('a failed step is retried on the next run; completed steps are not', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    let aRuns = 0;
    let bAttempts = 0;
    const fn = async (ctx: DurableCtx): Promise<string> => {
      await ctx.step('a', () => { aRuns++; return 'ok'; });
      return ctx.step('b', () => {
        bAttempts++;
        if (bAttempts < 2) throw new Error('transient');
        return 'recovered';
      });
    };
    const first = await runner.run('r1', fn);
    expect(first).toEqual({ status: 'failed', error: 'transient' });
    const second = await runner.run('r1', fn);
    expect(second).toEqual({ status: 'completed', value: 'recovered' });
    expect(aRuns).toBe(1); // memoized across the retry
  });

  it('Promise.all parallel steps replay correctly (name-keyed, not order-keyed)', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    const executed: string[] = [];
    const fn = async (ctx: DurableCtx): Promise<number[]> =>
      Promise.all([0, 1, 2].map((i) =>
        ctx.step(`fetch:${i}`, () => { executed.push(`fetch:${i}`); return i * 10; }),
      ));
    const r1 = await runner.run('r1', fn);
    expect(r1).toEqual({ status: 'completed', value: [0, 10, 20] });
    const r2 = await runner.run('r1', fn);
    expect(r2).toEqual({ status: 'completed', value: [0, 10, 20] });
    expect(executed).toHaveLength(3); // no re-execution on replay
  });
});

describe('DurableRunner — interrupt (human-in-the-loop)', () => {
  it('suspends, then resumes with the resolved value', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    const fn = async (ctx: DurableCtx): Promise<string> => {
      const draft = await ctx.step('draft', () => 'refund $400');
      const approved = await ctx.interrupt<boolean>('approval', { action: draft });
      return approved ? 'executed' : 'rejected';
    };

    const first = await runner.run('r1', fn);
    expect(first).toEqual({
      status: 'suspended', reason: 'interrupt', stepName: 'approval',
      payload: { action: 'refund $400' },
    });

    expect(await runner.pendingInterrupts('r1')).toEqual([
      { name: 'approval', payload: { action: 'refund $400' } },
    ]);

    await runner.resolveInterrupt('r1', 'approval', true);
    const second = await runner.run('r1', fn);
    expect(second).toEqual({ status: 'completed', value: 'executed' });
  });

  it('re-running an unresolved interrupt stays suspended (idempotent)', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    const fn = async (ctx: DurableCtx): Promise<unknown> => ctx.interrupt('gate');
    expect((await runner.run('r1', fn)).status).toBe('suspended');
    expect((await runner.run('r1', fn)).status).toBe('suspended');
    expect(await runner.pendingInterrupts('r1')).toHaveLength(1);
  });

  it('resolveInterrupt rejects unknown / already-resolved / non-interrupt names', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    const fn = async (ctx: DurableCtx): Promise<unknown> => {
      await ctx.step('s', () => 1);
      return ctx.interrupt('gate');
    };
    await runner.run('r1', fn);
    await expect(runner.resolveInterrupt('r1', 'nope', 1)).rejects.toThrow(/no interrupt/);
    await expect(runner.resolveInterrupt('r1', 's', 1)).rejects.toThrow(/not an interrupt/);
    await runner.resolveInterrupt('r1', 'gate', 'v');
    await expect(runner.resolveInterrupt('r1', 'gate', 'v')).rejects.toThrow(/already resolved/);
  });

  it('composes with an ApprovalGate-shaped policy (governance pattern)', async () => {
    // Stand-in for @tenet/governance PolicyEvaluator output.
    const evaluatePolicy = (tool: string): 'allow' | 'require_approval' =>
      tool === 'refund' ? 'require_approval' : 'allow';

    const runner = new DurableRunner(new InMemoryJournalStore());
    const fn = async (ctx: DurableCtx): Promise<string> => {
      const decision = await ctx.step('policy', () => evaluatePolicy('refund'));
      if (decision === 'require_approval') {
        const ok = await ctx.interrupt<boolean>('approve:refund', { tool: 'refund' });
        if (!ok) return 'denied by approver';
      }
      return 'tool executed';
    };

    expect((await runner.run('r1', fn)).status).toBe('suspended');
    await runner.resolveInterrupt('r1', 'approve:refund', false);
    expect(await runner.run('r1', fn)).toEqual({ status: 'completed', value: 'denied by approver' });
  });
});

describe('DurableRunner — durable sleep', () => {
  it('suspends until the clock passes wakeAt, then continues', async () => {
    let clock = 1_000;
    const runner = new DurableRunner(new InMemoryJournalStore(), { now: () => clock });
    const fn = async (ctx: DurableCtx): Promise<string> => {
      await ctx.step('before', () => 'x');
      await ctx.sleep('cooldown', 5_000);
      return 'awake';
    };

    const first = await runner.run('r1', fn);
    expect(first).toEqual({
      status: 'suspended', reason: 'sleep', stepName: 'cooldown', payload: { wakeAt: 6_000 },
    });

    clock = 3_000; // too early
    expect((await runner.run('r1', fn)).status).toBe('suspended');

    clock = 6_000; // due
    expect(await runner.run('r1', fn)).toEqual({ status: 'completed', value: 'awake' });
  });

  it('rejects negative ms', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    const result = await runner.run('r1', async (ctx) => ctx.sleep('bad', -1));
    expect(result.status).toBe('failed');
  });
});

describe('DurableRunner — determinism guards', () => {
  it('throws NondeterminismError on duplicate step names in one replay', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    await expect(runner.run('r1', async (ctx) => {
      await ctx.step('same', () => 1);
      await ctx.step('same', () => 2);
      return 0;
    })).rejects.toThrow(NondeterminismError);
  });

  it('throws NondeterminismError when a name changes kind between replays', async () => {
    const journal = new InMemoryJournalStore();
    const runner = new DurableRunner(journal);
    await runner.run('r1', async (ctx) => ctx.step('thing', () => 1));
    await expect(
      runner.run('r1', async (ctx) => ctx.interrupt('thing')),
    ).rejects.toThrow(NondeterminismError);
  });

  it('requires a runId', async () => {
    const runner = new DurableRunner(new InMemoryJournalStore());
    await expect(runner.run('', async () => 0)).rejects.toThrow(/runId/);
  });
});

describe('StateStoreJournal — persistence through a StateStore', () => {
  function memStore(): StateStoreLike & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      async get(k) { return data.get(k) ?? null; },
      async set(k, v) { data.set(k, v); },
    };
  }

  it('a run survives a "process restart" (fresh runner, same store)', async () => {
    const store = memStore();
    const fn = async (ctx: DurableCtx): Promise<string> => {
      await ctx.step('work', () => 'done-once');
      const ok = await ctx.interrupt<boolean>('gate');
      return ok ? 'finished' : 'stopped';
    };

    // Process 1: runs, suspends at the gate.
    const runner1 = new DurableRunner(new StateStoreJournal(store));
    expect((await runner1.run('r1', fn)).status).toBe('suspended');

    // "Restart": brand-new runner + journal object over the same store.
    const runner2 = new DurableRunner(new StateStoreJournal(store));
    await runner2.resolveInterrupt('r1', 'gate', true);
    expect(await runner2.run('r1', fn)).toEqual({ status: 'completed', value: 'finished' });
  });

  it('parallel appends do not lose entries (write serialization)', async () => {
    const store = memStore();
    const runner = new DurableRunner(new StateStoreJournal(store));
    const result = await runner.run('r1', async (ctx) =>
      Promise.all(Array.from({ length: 8 }, (_, i) => ctx.step(`p:${i}`, () => i))),
    );
    expect(result.status).toBe('completed');
    const journal = new StateStoreJournal(store);
    expect(await journal.load('r1')).toHaveLength(8);
  });

  it('respects key prefix', async () => {
    const store = memStore();
    const journal = new StateStoreJournal(store, { prefix: 'custom:' });
    await journal.append('r1', { name: 'a', kind: 'step', status: 'ok', data: '1' });
    expect([...store.data.keys()]).toEqual(['custom:r1']);
  });
});
