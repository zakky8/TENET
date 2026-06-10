import {
  ContextCompactor,
  TodoLedger,
  spawnSubagents,
  isHandoff,
  charsPerTokenEstimator,
  type HarnessMessage,
  type Summarizer,
  type SubagentTask,
} from './index.js';

const fakeSummarizer: Summarizer = {
  async summarize(messages) {
    return `digest of ${messages.length} messages`;
  },
};

function msg(role: HarnessMessage['role'], content: string): HarnessMessage {
  return { role, content };
}

describe('ContextCompactor', () => {
  it('returns input unchanged when under budget', async () => {
    const c = new ContextCompactor(fakeSummarizer, { budgetTokens: 1000 });
    const messages = [msg('system', 'be helpful'), msg('user', 'hi')];
    const result = await c.compact(messages);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('summarizes the middle, pins system prompt, keeps recent verbatim', async () => {
    const longText = 'x'.repeat(400); // ~100 tokens each
    const messages: HarnessMessage[] = [
      msg('system', 'SYSTEM PROMPT'),
      ...Array.from({ length: 10 }, (_, i) => msg('user', `${longText}:${i}`)),
      msg('user', 'recent-1'),
      msg('assistant', 'recent-2'),
    ];
    const c = new ContextCompactor(fakeSummarizer, { budgetTokens: 300, keepRecent: 2 });
    const result = await c.compact(messages);

    expect(result.compacted).toBe(true);
    expect(result.messages[0]!.content).toBe('SYSTEM PROMPT');
    expect(result.messages[1]!.role).toBe('system');
    expect(result.messages[1]!.content).toContain('digest of 10 messages');
    expect(result.messages.at(-2)!.content).toBe('recent-1');
    expect(result.messages.at(-1)!.content).toBe('recent-2');
    expect(result.after).toBeLessThan(result.before);
  });

  it('does not compact when only system + recent window remain', async () => {
    const c = new ContextCompactor(fakeSummarizer, { budgetTokens: 1, keepRecent: 8 });
    const messages = [msg('system', 'sys'), msg('user', 'only message')];
    const result = await c.compact(messages);
    expect(result.compacted).toBe(false); // nothing in the middle to fold
  });

  it('validates constructor args', () => {
    expect(() => new ContextCompactor(fakeSummarizer, { budgetTokens: 0 })).toThrow();
    expect(() => new ContextCompactor(fakeSummarizer, { budgetTokens: 10, keepRecent: -1 })).toThrow();
  });

  it('charsPerTokenEstimator rounds up', () => {
    expect(charsPerTokenEstimator('abcd')).toBe(1);
    expect(charsPerTokenEstimator('abcde')).toBe(2);
    expect(charsPerTokenEstimator('')).toBe(0);
  });
});

describe('TodoLedger', () => {
  it('add → start → complete lifecycle + render', () => {
    const ledger = new TodoLedger();
    const a = ledger.add('write tests');
    const b = ledger.add('ship feature');
    ledger.start(a.id);
    ledger.complete(a.id, 'done in 5m');
    expect(ledger.render()).toBe('[x] #1 write tests — done in 5m\n[ ] #2 ship feature');
    expect(ledger.settled()).toBe(false);
    ledger.fail(b.id, 'blocked');
    expect(ledger.settled()).toBe(true);
  });

  it('JSON round-trip preserves items and id counter', () => {
    const ledger = new TodoLedger();
    ledger.add('one');
    ledger.complete(1);
    const restored = TodoLedger.fromJSON(ledger.toJSON());
    expect(restored.list()).toEqual(ledger.list());
    expect(restored.add('two').id).toBe(2); // counter continues, no collision
  });

  it('rejects empty subjects, unknown ids, restarting completed', () => {
    const ledger = new TodoLedger();
    expect(() => ledger.add('  ')).toThrow(/required/);
    expect(() => ledger.start(99)).toThrow(/not found/);
    const t = ledger.add('x');
    ledger.complete(t.id);
    expect(() => ledger.start(t.id)).toThrow(/already completed/);
  });

  it('fromJSON rejects malformed payloads', () => {
    expect(() => TodoLedger.fromJSON('{"items":"nope","nextId":1}')).toThrow(/malformed/);
  });
});

describe('spawnSubagents', () => {
  it('runs all tasks, results in input order, errors isolated', async () => {
    const tasks: SubagentTask<string>[] = [
      { name: 'a', run: async () => 'A' },
      { name: 'b', run: async () => { throw new Error('b failed'); } },
      { name: 'c', run: async () => 'C' },
    ];
    const results = await spawnSubagents(tasks, { concurrency: 2 });
    expect(results).toEqual([
      { name: 'a', status: 'ok', value: 'A' },
      { name: 'b', status: 'error', error: 'b failed' },
      { name: 'c', status: 'ok', value: 'C' },
    ]);
  });

  it('enforces the concurrency cap', async () => {
    let running = 0;
    let peak = 0;
    const make = (name: string): SubagentTask<null> => ({
      name,
      run: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return null;
      },
    });
    await spawnSubagents([make('1'), make('2'), make('3'), make('4'), make('5')], { concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('abort marks queued tasks as errors', async () => {
    const ctrl = new AbortController();
    const tasks: SubagentTask<string>[] = [
      { name: 'first', run: async () => { ctrl.abort(); return 'done'; } },
      { name: 'second', run: async () => 'never-queued-after-abort' },
    ];
    const results = await spawnSubagents(tasks, { concurrency: 1, signal: ctrl.signal });
    expect(results[0]).toEqual({ name: 'first', status: 'ok', value: 'done' });
    expect(results[1]).toEqual({ name: 'second', status: 'error', error: 'aborted' });
  });

  it('rejects duplicate names and bad concurrency', async () => {
    const t = (name: string): SubagentTask<null> => ({ name, run: async () => null });
    await expect(spawnSubagents([t('x'), t('x')])).rejects.toThrow(/duplicate/);
    await expect(spawnSubagents([t('x')], { concurrency: 0 })).rejects.toThrow(/concurrency/);
  });

  it('empty task list resolves to empty results', async () => {
    expect(await spawnSubagents([])).toEqual([]);
  });
});

describe('isHandoff', () => {
  it('accepts well-formed handoffs and rejects others', () => {
    expect(isHandoff({ kind: 'handoff', target: 'billing-agent', reason: 'invoice question' })).toBe(true);
    expect(isHandoff({ kind: 'handoff', target: 'x' })).toBe(false);
    expect(isHandoff({ kind: 'other' })).toBe(false);
    expect(isHandoff(null)).toBe(false);
    expect(isHandoff('handoff')).toBe(false);
  });
});
