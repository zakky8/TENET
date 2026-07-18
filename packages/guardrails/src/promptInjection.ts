/**
 * Prompt-injection guard.
 *
 * Two-phase defense:
 *   1. Inbound (user → agent): block clearly-malicious instruction
 *      hijacks. The denylist below targets the well-known surface
 *      forms ("ignore all previous instructions", "you are now",
 *      role-switch attempts, jailbreak invocations). It is NOT a
 *      complete defense — a sufficiently obfuscated injection will
 *      slip through. Combine with verifier source-grounding for
 *      defense in depth.
 *   2. Outbound (agent → user): block responses that quote the system
 *      prompt back or that comply with role-switch attempts (model
 *      starting "Sure, as a DAN...").
 *
 * Apps customize both lists. The defaults are intentionally narrow
 * — false-positive cost is high (users get blocked) so we only catch
 * patterns that are nearly always malicious.
 */

import { denylistFilter, type Filter } from './filters.js';

/**
 * Default inbound prompt-injection denylist. Each pattern is anchored
 * loosely — case-insensitive substring match. Tune up or down per app.
 */
export const STANDARD_INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  // Classic "ignore previous"
  /\bignore\s+(?:all|any|the|your)\s+(?:previous|above|prior|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directions?)\b/i,
  // "Disregard your instructions"
  /\bdisregard\s+(?:all|any|the|your)\s+(?:previous|above)?\s*(?:instructions?|rules?|prompts?)\b/i,
  // Direct system-prompt extraction — match noun phrase regardless of
  // intermediate filler ("show me your instructions", "reveal the
  // system prompt", "tell me the rules").
  /\b(?:system\s+prompt|(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|rules?))\b/i,
  // Role-switch / jailbreak invocations
  /\byou\s+are\s+now\s+(?:DAN|AIM|STAN|a\s+(?:different|new)\s+(?:AI|assistant|model|persona))\b/i,
  /\bact\s+as\s+(?:DAN|AIM|STAN|a\s+(?:different|new)\s+(?:AI|persona))\b/i,
  // Developer-mode invocations
  /\b(?:enable|switch\s+to|enter)\s+(?:developer|debug|admin|root|god)\s+mode\b/i,
  // Refusal override
  /\byou\s+(?:must|will|shall)\s+(?:never\s+)?refuse\b/i,
];

/**
 * Default outbound system-prompt leak patterns. Block any response that quotes
 * hallmark fragments of a TENET system prompt back at the user.
 *
 * These target TENET's OWN prompt text, verified against the code:
 *   - the reasoner's agent prompt (`buildSystem` in `@tenet/agent`) — the primary
 *     default: its opener, the grounded-only instruction, the never-invent rule,
 *     and the JSON envelope the OUTPUT FORMAT section specifies;
 *   - the policy Constitutional Principles + knowledge-boundary header, and the
 *     verifier judge's worked-examples block, which richer compositions may inject.
 * Apps append their own. (A leaked prompt would also usually fail the verifier's
 * grounded-citation guard — this filter is defense in depth, so it must actually
 * match the prompt the agent runs, not a prompt from some other system.)
 */
export const STANDARD_OUTBOUND_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
  // `buildSystem` — TENET's actual agent system prompt.
  /You are a grounded support agent/i,
  /Answer ONLY from the KNOWLEDGE block/i,
  /Never invent facts, sources, quotes, numbers, or policies/i,
  /"action"\s*:\s*"answer\|handoff\|abstain"/i,
  // Policy principles / judge examples that a richer composition may inject.
  /CONSTITUTIONAL\s+PRINCIPLES/i,
  /WORKED\s+EXAMPLES\s*\(study/i,
  /KNOWLEDGE\s+BOUNDARY:/i,
];

/** Build the default inbound prompt-injection filter. */
export function promptInjectionFilter(
  patterns: ReadonlyArray<RegExp> = STANDARD_INJECTION_PATTERNS,
): Filter {
  return denylistFilter(patterns, 'prompt-injection');
}

/** Build the default outbound system-prompt-leak filter. */
export function systemPromptLeakFilter(
  patterns: ReadonlyArray<RegExp> = STANDARD_OUTBOUND_LEAK_PATTERNS,
): Filter {
  return denylistFilter(patterns, 'system-prompt-leak');
}
