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
 * Default outbound system-prompt leak patterns. Block any response
 * that quotes hallmark fragments of a standard system prompt back at
 * the user.
 */
export const STANDARD_OUTBOUND_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
  /CONSTITUTIONAL\s+PRINCIPLES/i,
  /WORKED\s+EXAMPLES\s*\(study/i,
  /BASE_RULES/i,
  /Master\s+Fact\s+Sheet/i,
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
