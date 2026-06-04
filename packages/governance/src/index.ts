/**
 * Pre-tool-call policy + approval gates + structured audit.
 *
 * The unfilled OSS-agent-framework gap. Verified by 2026 research:
 * "None evaluates a tool call against a policy before it executes,
 *  none requires approval gates by default, none ships a structured
 *  audit trail without custom integration."
 *
 * This module fixes all three:
 *   1. PolicyEvaluator — synchronous deny/allow/require_approval
 *      decision per tool-call, before execution
 *   2. ApprovalGate — pluggable HITL injection (operator wires
 *      Slack / Teams / email / dashboard); decisions cached by
 *      stable approval id so retries are idempotent
 *   3. AuditSink — structured append-only event log; every decision
 *      + outcome + override emits one event
 *
 * Pure functions + injected sinks; no I/O. Operator wires Redis /
 * S3 / Postgres on the AuditSink interface. Approval cache is also
 * an interface; default is in-memory.
 */

// ── Decisions ─────────────────────────────────────────────────────────

export type PolicyDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'require_approval'; reason: string; approvalKey: string };

/** What we evaluate against. */
export interface ToolCallContext {
  /** Stable tool name (e.g. 'db.refund' or 'email.send'). */
  toolName: string;
  /** Caller-supplied arguments. Should NOT contain Secret<T> values. */
  args: Readonly<Record<string, unknown>>;
  /** Tenant scope. */
  tenantId: string;
  /** Acting principal — bot id, user id, automation id. */
  principalId: string;
  /** Optional risk tags the policy can use ('financial' / 'pii' / ...). */
  tags?: ReadonlyArray<string>;
}

// ── Policy ────────────────────────────────────────────────────────────

/**
 * A rule is a pure function returning the strictest decision it sees.
 * Operator ships a list; PolicyEvaluator runs them in order and the
 * FIRST non-allow decision wins (deny > require_approval > allow).
 */
export type PolicyRule = (ctx: ToolCallContext) => PolicyDecision;

export class PolicyEvaluator {
  constructor(private readonly rules: ReadonlyArray<PolicyRule>) {}

  evaluate(ctx: ToolCallContext): PolicyDecision {
    for (const rule of this.rules) {
      const d = rule(ctx);
      if (d.kind !== 'allow') return d;
    }
    return { kind: 'allow' };
  }
}

// ── Built-in rules ────────────────────────────────────────────────────

/** Deny when tool name is not in the allow-list. */
export function allowListRule(allowList: ReadonlyArray<string>): PolicyRule {
  const set = new Set(allowList);
  return (ctx) =>
    set.has(ctx.toolName)
      ? { kind: 'allow' }
      : { kind: 'deny', reason: `tool ${ctx.toolName} not in allow-list` };
}

/** Require approval when any tag in the input list is present. */
export function tagRequiresApprovalRule(tagsThatRequire: ReadonlyArray<string>): PolicyRule {
  const set = new Set(tagsThatRequire);
  return (ctx) => {
    const matched = (ctx.tags ?? []).filter((t) => set.has(t));
    if (matched.length === 0) return { kind: 'allow' };
    return {
      kind: 'require_approval',
      reason: `tags require approval: ${matched.join(',')}`,
      approvalKey: stableApprovalKey(ctx),
    };
  };
}

/** Deny when an arg's value matches a forbidden-pattern regex. */
export function denyArgPatternRule(argName: string, forbidden: RegExp): PolicyRule {
  return (ctx) => {
    const v = ctx.args[argName];
    if (typeof v === 'string' && forbidden.test(v)) {
      return { kind: 'deny', reason: `${argName} matches forbidden pattern` };
    }
    return { kind: 'allow' };
  };
}

/** Deny when arg value is numerically above a threshold. */
export function numericLimitRule(argName: string, max: number): PolicyRule {
  return (ctx) => {
    const v = ctx.args[argName];
    if (typeof v === 'number' && v > max) {
      return { kind: 'deny', reason: `${argName}=${v} exceeds limit ${max}` };
    }
    return { kind: 'allow' };
  };
}

// ── Approval cache ────────────────────────────────────────────────────

export type ApprovalRecord = { decision: 'approve' | 'reject'; by: string; atMs: number };

export interface ApprovalStore {
  get(key: string): Promise<ApprovalRecord | undefined>;
  set(key: string, rec: ApprovalRecord): Promise<void>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly store = new Map<string, ApprovalRecord>();
  async get(key: string): Promise<ApprovalRecord | undefined> { return this.store.get(key); }
  async set(key: string, rec: ApprovalRecord): Promise<void> { this.store.set(key, rec); }
}

/** Deterministic key for ToolCallContext (idempotent approvals). */
export function stableApprovalKey(ctx: ToolCallContext): string {
  // Sort arg keys so {a:1,b:2} === {b:2,a:1}
  const sortedArgs = Object.fromEntries(
    Object.entries(ctx.args).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  return `${ctx.tenantId}|${ctx.principalId}|${ctx.toolName}|${JSON.stringify(sortedArgs)}`;
}

// ── Approval gate ─────────────────────────────────────────────────────

/**
 * Inject one of these: route a require-approval request to your
 * Slack/Teams/email/dashboard surface. Resolve when the human (or
 * scripted authority) clicks approve/reject.
 */
export interface ApprovalRequester {
  request(args: {
    ctx: ToolCallContext;
    reason: string;
    approvalKey: string;
    signal?: AbortSignal;
  }): Promise<ApprovalRecord>;
}

export class ApprovalGate {
  constructor(
    private readonly store: ApprovalStore,
    private readonly requester: ApprovalRequester,
  ) {}

  /** Idempotent: returns the cached decision if any, otherwise asks. */
  async requestOrCached(args: {
    ctx: ToolCallContext;
    reason: string;
    approvalKey: string;
    signal?: AbortSignal;
  }): Promise<ApprovalRecord> {
    const cached = await this.store.get(args.approvalKey);
    if (cached) return cached;
    const rec = await this.requester.request(args);
    await this.store.set(args.approvalKey, rec);
    return rec;
  }
}

// ── Audit ─────────────────────────────────────────────────────────────

export type AuditEvent =
  | { kind: 'policy.allow'; tMs: number; ctx: ToolCallContext }
  | { kind: 'policy.deny'; tMs: number; ctx: ToolCallContext; reason: string }
  | { kind: 'policy.require_approval'; tMs: number; ctx: ToolCallContext; reason: string; approvalKey: string }
  | { kind: 'approval.decision'; tMs: number; ctx: ToolCallContext; approvalKey: string; decision: 'approve' | 'reject'; by: string }
  | { kind: 'tool.invoked'; tMs: number; ctx: ToolCallContext; outcome: 'ok' | 'error'; durationMs: number }
  | { kind: 'override'; tMs: number; ctx: ToolCallContext; by: string; reason: string };

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> { this.events.push(event); }
}

// ── Governance — composes the three ───────────────────────────────────

export class GovernanceError extends Error {
  constructor(public readonly code: 'denied' | 'rejected' | 'aborted', message: string) {
    super(message);
    this.name = 'GovernanceError';
  }
}

export class Governance {
  constructor(
    private readonly policy: PolicyEvaluator,
    private readonly gate: ApprovalGate,
    private readonly audit: AuditSink,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * The chokepoint: every tool invocation goes through governApprove().
   * If allow → returns. If deny → throws GovernanceError. If require_
   * approval → asks the gate, throws on reject.
   */
  async governApprove(ctx: ToolCallContext, signal?: AbortSignal): Promise<void> {
    const decision = this.policy.evaluate(ctx);
    const tMs = this.clock();
    switch (decision.kind) {
      case 'allow':
        await this.audit.emit({ kind: 'policy.allow', tMs, ctx });
        return;
      case 'deny':
        await this.audit.emit({ kind: 'policy.deny', tMs, ctx, reason: decision.reason });
        throw new GovernanceError('denied', decision.reason);
      case 'require_approval': {
        await this.audit.emit({
          kind: 'policy.require_approval',
          tMs,
          ctx,
          reason: decision.reason,
          approvalKey: decision.approvalKey,
        });
        const rec = await this.gate.requestOrCached({
          ctx,
          reason: decision.reason,
          approvalKey: decision.approvalKey,
          ...(signal !== undefined ? { signal } : {}),
        });
        await this.audit.emit({
          kind: 'approval.decision',
          tMs: this.clock(),
          ctx,
          approvalKey: decision.approvalKey,
          decision: rec.decision,
          by: rec.by,
        });
        if (rec.decision === 'reject') {
          throw new GovernanceError('rejected', `approval rejected by ${rec.by}`);
        }
        return;
      }
    }
  }

  /** Wrap a tool invocation: governApprove + run + emit outcome. */
  async invoke<T>(
    ctx: ToolCallContext,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.governApprove(ctx, signal);
    const start = this.clock();
    try {
      const r = await run();
      await this.audit.emit({
        kind: 'tool.invoked',
        tMs: this.clock(),
        ctx,
        outcome: 'ok',
        durationMs: this.clock() - start,
      });
      return r;
    } catch (e) {
      await this.audit.emit({
        kind: 'tool.invoked',
        tMs: this.clock(),
        ctx,
        outcome: 'error',
        durationMs: this.clock() - start,
      });
      throw e;
    }
  }

  /** Operator-stamped override — bypasses approval; emits override event for the audit log. */
  async override(ctx: ToolCallContext, by: string, reason: string): Promise<void> {
    await this.audit.emit({ kind: 'override', tMs: this.clock(), ctx, by, reason });
  }
}

export const VERSION = '0.0.0';
