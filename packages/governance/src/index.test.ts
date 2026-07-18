import {
  Governance,
  GovernanceError,
  PolicyEvaluator,
  ApprovalGate,
  InMemoryApprovalStore,
  InMemoryAuditSink,
  allowListRule,
  tagRequiresApprovalRule,
  denyArgPatternRule,
  numericLimitRule,
  stableApprovalKey,
  type ApprovalRequester,
  type ApprovalRecord,
  type ToolCallContext,
} from './index.js';

const ctx = (overrides: Partial<ToolCallContext> = {}): ToolCallContext => ({
  toolName: 'echo',
  args: {},
  tenantId: 't1',
  principalId: 'bot1',
  ...overrides,
});

function fixedRequester(rec: ApprovalRecord): { requester: ApprovalRequester; calls: number } {
  let calls = 0;
  return {
    requester: { async request() { calls++; return rec; } },
    get calls() { return calls; },
  };
}

let nowMs = 1_000;
const clock = (): number => nowMs;

describe('rules', () => {
  it('allowListRule lets through allowed tools, denies others', () => {
    const r = allowListRule(['ok']);
    expect(r(ctx({ toolName: 'ok' }))).toEqual({ kind: 'allow' });
    expect(r(ctx({ toolName: 'banned' })).kind).toBe('deny');
  });

  it('tagRequiresApprovalRule fires on tag match with stable key', () => {
    const r = tagRequiresApprovalRule(['financial']);
    const d = r(ctx({ tags: ['financial', 'pii'] }));
    expect(d.kind).toBe('require_approval');
    if (d.kind === 'require_approval') {
      expect(d.approvalKey).toContain('echo');
      expect(d.reason).toContain('financial');
    }
  });

  it('denyArgPatternRule denies forbidden patterns', () => {
    const r = denyArgPatternRule('email', /admin@/);
    expect(r(ctx({ args: { email: 'admin@x' } })).kind).toBe('deny');
    expect(r(ctx({ args: { email: 'user@x' } })).kind).toBe('allow');
  });

  it('numericLimitRule denies overage', () => {
    const r = numericLimitRule('amount', 100);
    expect(r(ctx({ args: { amount: 200 } })).kind).toBe('deny');
    expect(r(ctx({ args: { amount: 50 } })).kind).toBe('allow');
  });
});

describe('PolicyEvaluator', () => {
  it('first non-allow wins', () => {
    const p = new PolicyEvaluator([
      (): { kind: 'allow' } => ({ kind: 'allow' }),
      () => ({ kind: 'deny', reason: 'no' }),
      () => ({ kind: 'allow' }),
    ]);
    expect(p.evaluate(ctx()).kind).toBe('deny');
  });

  it('all allow → allow', () => {
    const p = new PolicyEvaluator([() => ({ kind: 'allow' })]);
    expect(p.evaluate(ctx())).toEqual({ kind: 'allow' });
  });
});

describe('stableApprovalKey', () => {
  it('argument order does not affect key', () => {
    const a = stableApprovalKey(ctx({ args: { a: 1, b: 2 } }));
    const b = stableApprovalKey(ctx({ args: { b: 2, a: 1 } }));
    expect(a).toBe(b);
  });

  it('NESTED argument order does not affect key (recursive canonicalisation — the bypass fix)', () => {
    // The 2026-06-04 hardening canonicalises RECURSIVELY. A partial (top-level-only)
    // canonicaliser would pass the flat test above yet let an attacker reorder NESTED
    // keys — inside objects AND inside array elements — to force a fresh approval prompt
    // that bypasses a prior rejection. Same operation ⇒ same key.
    const a = stableApprovalKey(ctx({ args: { outer: { a: 1, b: 2 }, items: [{ x: 1, y: 2 }] } }));
    const b = stableApprovalKey(ctx({ args: { items: [{ y: 2, x: 1 }], outer: { b: 2, a: 1 } } }));
    expect(a).toBe(b);
  });

  it('array element ORDER is significant — a reordered array is a DIFFERENT operation', () => {
    // Arrays are ordered; [1,2,3] and [3,2,1] are different calls and must NOT share an
    // approval (canonicalisation must sort object keys but PRESERVE array order).
    const a = stableApprovalKey(ctx({ args: { ids: [1, 2, 3] } }));
    const b = stableApprovalKey(ctx({ args: { ids: [3, 2, 1] } }));
    expect(a).not.toBe(b);
  });
});

describe('Governance.governApprove — allow / deny / approval paths', () => {
  it('allow path emits one audit event', async () => {
    const audit = new InMemoryAuditSink();
    const g = new Governance(
      new PolicyEvaluator([() => ({ kind: 'allow' })]),
      new ApprovalGate(new InMemoryApprovalStore(), fixedRequester({ decision: 'approve', by: 'op', atMs: 0 }).requester),
      audit,
      clock,
    );
    await g.governApprove(ctx());
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.kind).toBe('policy.allow');
  });

  it('deny path throws + emits deny event', async () => {
    const audit = new InMemoryAuditSink();
    const g = new Governance(
      new PolicyEvaluator([() => ({ kind: 'deny', reason: 'no' })]),
      new ApprovalGate(new InMemoryApprovalStore(), fixedRequester({ decision: 'approve', by: 'op', atMs: 0 }).requester),
      audit,
      clock,
    );
    await expect(g.governApprove(ctx())).rejects.toMatchObject({ code: 'denied' });
    expect(audit.events[0]!.kind).toBe('policy.deny');
  });

  it('approval path: approve → emits three events + does not throw', async () => {
    const audit = new InMemoryAuditSink();
    const g = new Governance(
      new PolicyEvaluator([(c) => ({ kind: 'require_approval', reason: 'r', approvalKey: stableApprovalKey(c) })]),
      new ApprovalGate(new InMemoryApprovalStore(), fixedRequester({ decision: 'approve', by: 'op', atMs: 5 }).requester),
      audit,
      clock,
    );
    await g.governApprove(ctx());
    expect(audit.events.map((e) => e.kind)).toEqual(['policy.require_approval', 'approval.decision']);
  });

  it('approval path: reject → throws', async () => {
    const audit = new InMemoryAuditSink();
    const g = new Governance(
      new PolicyEvaluator([(c) => ({ kind: 'require_approval', reason: 'r', approvalKey: stableApprovalKey(c) })]),
      new ApprovalGate(new InMemoryApprovalStore(), fixedRequester({ decision: 'reject', by: 'op', atMs: 0 }).requester),
      audit,
      clock,
    );
    await expect(g.governApprove(ctx())).rejects.toMatchObject({ code: 'rejected' });
  });

  it('approval cache: second call with same context does NOT re-request', async () => {
    const audit = new InMemoryAuditSink();
    const store = new InMemoryApprovalStore();
    const r = fixedRequester({ decision: 'approve', by: 'op', atMs: 0 });
    const g = new Governance(
      new PolicyEvaluator([(c) => ({ kind: 'require_approval', reason: 'r', approvalKey: stableApprovalKey(c) })]),
      new ApprovalGate(store, r.requester),
      audit,
      clock,
    );
    await g.governApprove(ctx({ args: { amount: 5 } }));
    await g.governApprove(ctx({ args: { amount: 5 } }));
    expect(r.calls).toBe(1);
  });
});

describe('Governance.invoke', () => {
  it('emits ok outcome on success', async () => {
    const audit = new InMemoryAuditSink();
    const g = new Governance(
      new PolicyEvaluator([() => ({ kind: 'allow' })]),
      new ApprovalGate(new InMemoryApprovalStore(), fixedRequester({ decision: 'approve', by: 'op', atMs: 0 }).requester),
      audit,
      clock,
    );
    const result = await g.invoke(ctx(), async () => 42);
    expect(result).toBe(42);
    const last = audit.events[audit.events.length - 1]!;
    expect(last.kind).toBe('tool.invoked');
    if (last.kind === 'tool.invoked') expect(last.outcome).toBe('ok');
  });

  it('emits error outcome on throw and re-throws', async () => {
    const audit = new InMemoryAuditSink();
    const g = new Governance(
      new PolicyEvaluator([() => ({ kind: 'allow' })]),
      new ApprovalGate(new InMemoryApprovalStore(), fixedRequester({ decision: 'approve', by: 'op', atMs: 0 }).requester),
      audit,
      clock,
    );
    await expect(g.invoke(ctx(), async () => { throw new Error('boom'); })).rejects.toThrow();
    const last = audit.events[audit.events.length - 1]!;
    if (last.kind === 'tool.invoked') expect(last.outcome).toBe('error');
  });

  it('blocks invocation on deny', async () => {
    let toolRan = false;
    const audit = new InMemoryAuditSink();
    const g = new Governance(
      new PolicyEvaluator([() => ({ kind: 'deny', reason: 'no' })]),
      new ApprovalGate(new InMemoryApprovalStore(), fixedRequester({ decision: 'approve', by: 'op', atMs: 0 }).requester),
      audit,
      clock,
    );
    await expect(g.invoke(ctx(), async () => { toolRan = true; return 1; })).rejects.toBeInstanceOf(GovernanceError);
    expect(toolRan).toBe(false);
  });
});

describe('Governance.override', () => {
  it('emits override event with operator + reason', async () => {
    const audit = new InMemoryAuditSink();
    const g = new Governance(
      new PolicyEvaluator([]),
      new ApprovalGate(new InMemoryApprovalStore(), fixedRequester({ decision: 'approve', by: 'op', atMs: 0 }).requester),
      audit,
      clock,
    );
    await g.override(ctx(), 'admin', 'emergency stop');
    expect(audit.events[0]).toMatchObject({ kind: 'override', by: 'admin', reason: 'emergency stop' });
  });
});
