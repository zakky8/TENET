/**
 * Deterministic tests for governance-gated tool execution (increment 2.1b-iii-b-i).
 *
 * The policy is a real PolicyEvaluator driven by fake rules; the executor is a fake
 * that records what it ran. The load-bearing properties: a denied batch executes
 * NOTHING (no partial side effects), require_approval is treated as denied (an
 * autonomous turn cannot approve), and a throwing tool becomes an isError result
 * rather than a dropped call or a fake success. Each test reddens if that regresses.
 */
import { PolicyEvaluator, type PolicyRule } from '@tenet/governance';
import type { ToolExecutor } from './deps.js';
import type { ToolCall } from './types.js';
import { runTools, type ToolRunContext } from './tools.js';

const RUN_CTX: ToolRunContext = { tenantId: 'tenant-1', principalId: 'bot-1' };
const call = (id: string, name: string, input: Record<string, unknown> = {}): ToolCall => ({
  id,
  name,
  input,
});

const ALLOW_ALL = new PolicyEvaluator([]);
const denyRule = (reason: string): PolicyRule => () => ({ kind: 'deny', reason });
const approvalRule = (): PolicyRule => () => ({
  kind: 'require_approval',
  reason: 'refunds need a human',
  approvalKey: 'refund',
});

/** Fake executor that records the calls it ran and returns a canned result. */
function recordingExecutor(result = { content: 'ok', isError: false }): ToolExecutor & {
  ran: string[];
} {
  const ran: string[] = [];
  return {
    ran,
    async execute(c) {
      ran.push(c.name);
      return result;
    },
  };
}
const throwingExecutor = (msg: string): ToolExecutor => ({
  async execute() {
    throw new Error(msg);
  },
});

describe('runTools — governance-gated, two-phase, fail closed', () => {
  it('all allowed → executes each and returns result blocks keyed by tool-use id', async () => {
    const exec = recordingExecutor({ content: 'balance: 100', isError: false });
    const out = await runTools([call('t1', 'kb.lookup')], exec, ALLOW_ALL, RUN_CTX);
    expect(out.denied).toBe(false);
    if (out.denied) throw new Error('unreachable');
    expect(out.results).toEqual([{ toolUseId: 't1', content: 'balance: 100', isError: false }]);
    expect(exec.ran).toEqual(['kb.lookup']);
  });

  it('a DENY denies the whole batch and executes NOTHING (no partial side effects)', async () => {
    const exec = recordingExecutor();
    const policy = new PolicyEvaluator([denyRule('kb.write not allowed')]);
    const out = await runTools([call('t1', 'kb.lookup'), call('t2', 'kb.write')], exec, policy, RUN_CTX);
    expect(out.denied).toBe(true);
    if (!out.denied) throw new Error('unreachable');
    expect(out.reason).toContain('not allowed');
    expect(exec.ran).toEqual([]); // phase-1 gate ran before ANY execution
  });

  it('require_approval is treated as DENIED (an autonomous turn cannot approve)', async () => {
    const exec = recordingExecutor();
    const policy = new PolicyEvaluator([approvalRule()]);
    const out = await runTools([call('t1', 'db.refund')], exec, policy, RUN_CTX);
    expect(out.denied).toBe(true);
    if (!out.denied) throw new Error('unreachable');
    expect(out.reason).toContain('approval required');
    expect(exec.ran).toEqual([]);
  });

  it('an allowed tool that THROWS → isError result block, not a dropped call or fake success', async () => {
    const out = await runTools([call('t1', 'kb.lookup')], throwingExecutor('network down'), ALLOW_ALL, RUN_CTX);
    expect(out.denied).toBe(false);
    if (out.denied) throw new Error('unreachable');
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.isError).toBe(true);
    expect(out.results[0]?.content).toContain('network down');
  });

  it('the policy sees the real tool name + args (so rules can actually gate on them)', async () => {
    const seen: Array<{ toolName: string; args: unknown }> = [];
    const spyRule: PolicyRule = (ctx) => {
      seen.push({ toolName: ctx.toolName, args: ctx.args });
      return { kind: 'allow' };
    };
    await runTools([call('t1', 'email.send', { to: 'x@y.z' })], recordingExecutor(), new PolicyEvaluator([spyRule]), RUN_CTX);
    expect(seen).toEqual([{ toolName: 'email.send', args: { to: 'x@y.z' } }]);
  });

  it('empty call list → allowed, no results (nothing to run)', async () => {
    const out = await runTools([], recordingExecutor(), ALLOW_ALL, RUN_CTX);
    expect(out).toEqual({ denied: false, results: [] });
  });
});
