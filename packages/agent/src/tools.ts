/**
 * Governance-gated tool execution (design gate §4.3, the `tool` branch).
 *
 * Two phases, in this order for a reason:
 *   1. GATE every requested call against the policy BEFORE executing ANY. The first
 *      non-allow decision denies the WHOLE batch with zero side effects — a forbidden
 *      call in a batch must never let its allowed siblings run first.
 *   2. Execute the (now all-allowed) calls in order.
 *
 * Fail-CLOSED semantics:
 *   - A `deny` OR a `require_approval` denies the batch. An autonomous turn cannot
 *     satisfy an approval, so require_approval is treated as "cannot proceed" — the
 *     caller hands off to a human, it never fabricates a tool result.
 *   - An allowed call that THROWS becomes an `isError` tool result fed back to the
 *     model (a tool error is not a turn-level failure) — but it is never silently
 *     dropped or turned into a fake success.
 */
import { PolicyEvaluator, type PolicyDecision } from '@tenet/governance';
import type { ToolExecutor } from './deps.js';
import type { ToolCall, ToolResultBlock } from './types.js';

/** The scope a batch of tool calls executes under (from the turn's event). */
export interface ToolRunContext {
  readonly tenantId: string;
  readonly principalId: string;
}

/** Either every call was allowed and executed (results, possibly with isError blocks),
 *  or the batch was denied by policy (caller fails closed → ops handoff). */
export type ToolRunResult =
  | { readonly denied: false; readonly results: ReadonlyArray<ToolResultBlock> }
  | { readonly denied: true; readonly reason: string };

export async function runTools(
  calls: ReadonlyArray<ToolCall>,
  executor: ToolExecutor,
  policy: PolicyEvaluator,
  runCtx: ToolRunContext,
  signal?: AbortSignal,
): Promise<ToolRunResult> {
  // Phase 1 — gate ALL before executing ANY.
  for (const call of calls) {
    // A ToolCall carries no risk `tags`, so tag-based policy rules
    // (e.g. tagRequiresApprovalRule) are inert on this path; a composition that needs
    // them must map tool name → tags in the executor/registry layer. Name/arg/numeric
    // rules gate correctly here regardless.
    const decision: PolicyDecision = policy.evaluate({
      toolName: call.name,
      args: call.input,
      tenantId: runCtx.tenantId,
      principalId: runCtx.principalId,
    });
    if (decision.kind !== 'allow') {
      const reason =
        decision.kind === 'deny' ? decision.reason : `approval required: ${decision.reason}`;
      return { denied: true, reason: `${call.name}: ${reason}` };
    }
  }

  // Phase 2 — all allowed, execute in order.
  const results: ToolResultBlock[] = [];
  for (const call of calls) {
    try {
      const out = await executor.execute(call, signal);
      results.push({ toolUseId: call.id, content: out.content, isError: out.isError });
    } catch (err) {
      results.push({
        toolUseId: call.id,
        content: `tool error: ${(err as Error).message}`,
        isError: true,
      });
    }
  }
  return { denied: false, results };
}
