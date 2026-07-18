/**
 * @tenet/surface-core — shared primitives for the surface send path.
 *
 * Today: a fail-closed grounded-render gate. The agent's single emit edge
 * already refuses to ship an uncited fact, but a surface may be handed a
 * reply from a path that bypassed it (a cache, a custom fast-path, a
 * bug). This gate is the last-mile belt-and-suspenders: a surface renders
 * a reply's text ONLY when it carries a grounded citation; otherwise it
 * renders a fixed safe `fallback` instead, so no ungrounded fact reaches a
 * member. It is the same bar the emit edge enforces, applied at the wire.
 */

import type { Citation } from '@tenet/core';

export * from './jwt.js';

/** The minimal outbound shape the gate inspects (a NormalizedReply satisfies it). */
export interface RenderableReply {
  text: string;
  citations: ReadonlyArray<Citation>;
}

export interface RenderGateOptions {
  /**
   * The safe message rendered INSTEAD when a fact-bearing reply is not
   * grounded. Required — the gate never silently drops a turn, and it must
   * never fall back to the (potentially ungrounded) reply text itself.
   */
  fallback: string;
}

export type RenderDecision =
  | { readonly grounded: true; readonly text: string; readonly citations: ReadonlyArray<Citation> }
  | { readonly grounded: false; readonly text: string; readonly reason: string };

/**
 * A citation grounds a reply only if it has a NON-BLANK source id AND quote —
 * the same guard the agent's emit edge applies (a blank/placeholder citation
 * is not grounding).
 */
export function hasGroundedCitation(citations: ReadonlyArray<Citation>): boolean {
  return citations.some((c) => c.sourceId.trim() !== '' && c.quote.trim() !== '');
}

/**
 * Fail-closed render-time grounding gate.
 *
 *   - `text` is blank            → nothing to render, nothing to leak → pass through.
 *   - `text` + ≥1 grounded cite  → a verified answer → render it as-is.
 *   - `text` + no grounded cite  → REFUSE: render the safe `fallback` instead.
 *
 * The gate is citation-based on purpose: it cannot (and must not try to)
 * tell a legitimate abstention message from a fabricated fact that lost its
 * citation, so it treats BOTH as "not renderable as a grounded answer" and
 * substitutes the operator's fallback. That is strictly safe — the only
 * cost is that a bare abstention message is replaced by the operator's
 * chosen safe message, which the operator controls.
 */
export function groundedRenderGate(reply: RenderableReply, opts: RenderGateOptions): RenderDecision {
  if (reply.text.trim() === '') {
    return { grounded: false, text: reply.text, reason: 'empty reply — nothing to render' };
  }
  if (hasGroundedCitation(reply.citations)) {
    return { grounded: true, text: reply.text, citations: reply.citations };
  }
  return {
    grounded: false,
    text: opts.fallback,
    reason: 'ungrounded reply (no grounded citation) — rendered safe fallback',
  };
}

export const VERSION = '0.0.0';
