/**
 * Terminal Result builders for the agent turn (design gate §4).
 *
 * A turn ends at exactly one terminal: emit (a grounded, verified answer), abstain
 * (fail-CLOSED — could not ground an answer), or handoff (routed to a human). Only
 * `emitResult` ever puts model-generated text in front of the member; `abstain` and
 * `handoff` return a fixed safe message. This is where "the worst outcome of a turn
 * is a human handoff, never an ungrounded fact" is made concrete.
 */
import type { Citation } from '@tenet/core';
import type { Result } from './types.js';

/** Fixed message when the agent cannot ground an answer. Generic — no tenant or
 *  domain specifics. The real reason travels in `Result.reason` (telemetry only). */
export const ABSTAIN_REPLY =
  "I don't have a confirmed answer for that, and I won't guess. I've flagged it for a person to follow up.";

/** Fixed message when the turn is routed to a human. */
export const HANDOFF_REPLY = 'Let me bring in a teammate to help with this — one moment.';

/** The ONLY terminal that emits model-generated text — reached solely past a
 *  fail-closed verify. Carries the verifier-approved citations. */
export function emitResult(draft: string, citations: ReadonlyArray<Citation>): Result {
  return { reply: { text: draft, citations }, outcome: 'resolved' };
}

/** Fail-CLOSED terminal: the agent could not ground an answer. Never emits model
 *  text — a fixed safe message + a `disqualified` outcome. `reason` is carried for
 *  telemetry/debugging, not shown to the member. */
export function abstainResult(reason: string): Result {
  return { reply: { text: ABSTAIN_REPLY, citations: [] }, outcome: 'disqualified', reason };
}

/** Terminal that hands the turn to a human. `target` (the queue/role) is preserved
 *  in `reason` for routing/telemetry. */
export function handoffResult(target: string, reason: string): Result {
  return {
    reply: { text: HANDOFF_REPLY, citations: [] },
    outcome: 'handed_off',
    reason: `${target}: ${reason}`,
  };
}
