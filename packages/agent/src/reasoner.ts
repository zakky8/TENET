/**
 * The decides-and-drafts Reasoner — increment 2.2a (design gate:
 * docs/design/agent-turn.md §3).
 *
 * `modelReasoner` maps ONE canonical `ChatResponse` to ONE `ReasonerOutput`,
 * FAIL-CLOSED on every ambiguity. This is the anti-hallucination core:
 *
 *   - There is NO default `answer`. Every uncertain path resolves to `abstain`.
 *   - An `answer` MUST carry at least one citation with a verbatim quote
 *     (grounded-or-abstain). An uncited answer is discarded, not repaired.
 *   - `refusal` / `aborted` stop reasons abstain. A `tool_use` stop with no
 *     tool blocks abstains.
 *   - Any envelope parse failure, unknown action, or missing field abstains.
 *
 * The machinery here is deterministic and fully testable without a model:
 * the prompt (`buildSystem`) merely ASKS for the envelope; `parseEnvelope`
 * ENFORCES it. If the model misbehaves in any way, the guarantee holds because
 * the enforcement side never trusts the model.
 */
import {
  type ChatModel,
  type ChatResponse,
  type Citation,
  type ToolDef,
  responseText,
  textMessage,
  toolUses,
} from '@tenet/core';
import type { OrchestratorState, Reasoner, ReasonerOutput } from './types.js';

// ── modelReasoner ───────────────────────────────────────────────────────────

/**
 * Wrap a canonical `ChatModel` as the turn's `Reasoner`. `tools` are offered
 * to the model only when non-empty (conditional spread — the canonical
 * ChatRequest treats `tools` as absent-or-present, never `undefined`).
 */
export function modelReasoner(model: ChatModel, tools: ReadonlyArray<ToolDef>): Reasoner {
  return {
    async reason(state: OrchestratorState, signal: AbortSignal): Promise<ReasonerOutput> {
      const res: ChatResponse = await model.chat({
        system: buildSystem(state),
        messages: state.history.map((m) => textMessage(m.role, m.content)),
        maxTokens: 1024,
        ...(tools.length > 0 ? { tools } : {}),
        signal,
      });

      if (res.stopReason === 'tool_use') {
        const calls = toolUses(res).map((t) => ({ id: t.id, name: t.name, input: t.input }));
        return calls.length > 0
          ? { kind: 'tool', calls }
          : { kind: 'abstain', reason: 'tool_use stop with no tool blocks' }; // FAIL CLOSED
      }

      // refusal / aborted / max_tokens all mean the turn cannot be trusted: a refusal is
      // not an answer, an abort was cancelled, and max_tokens means the response was
      // TRUNCATED — a cut-off draft/envelope must never ship. All → abstain.
      if (
        res.stopReason === 'refusal' ||
        res.stopReason === 'aborted' ||
        res.stopReason === 'max_tokens'
      ) {
        return { kind: 'abstain', reason: `model ${res.stopReason}` }; // FAIL CLOSED
      }

      // Text path: strict JSON envelope. Any parse failure / unknown action /
      // missing field → abstain. NEVER default to `answer`.
      return parseEnvelope(responseText(res));
    },
  };
}

// ── parseEnvelope — the fail-closed enforcement boundary ────────────────────

/**
 * Parse the model's text output into a `ReasonerOutput`. Tolerant on the way
 * IN (the model may wrap the JSON object in prose or markdown fences — we
 * extract the first balanced `{...}`), strict on the way OUT:
 *
 *   action 'answer'  → requires non-empty `text` AND ≥1 well-formed citation
 *                      ({sourceId, quote} both non-empty strings), else abstain.
 *   action 'handoff' → requires non-empty string `target`, else abstain.
 *   action 'abstain' → abstain with the model's reason (or a default).
 *   anything else    → abstain. No branch ever defaults to `answer`.
 */
export function parseEnvelope(text: string): ReasonerOutput {
  let parsed: unknown;
  try {
    const raw = extractJsonObject(text);
    if (raw === null) return { kind: 'abstain', reason: 'unparseable reasoner envelope' };
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'abstain', reason: 'unparseable reasoner envelope' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'abstain', reason: 'unknown reasoner action' };
  }
  const env = parsed as Readonly<Record<string, unknown>>;
  const action = env['action'];

  if (action === 'answer') {
    const draft = env['text'];
    const citations = parseCitations(env['citations']);
    if (typeof draft !== 'string' || draft.trim() === '' || citations === null) {
      return { kind: 'abstain', reason: 'answer without a grounded citation' }; // GROUNDED-OR-ABSTAIN
    }
    return { kind: 'answer', draft, citations };
  }

  if (action === 'handoff') {
    const target = env['target'];
    if (typeof target !== 'string' || target.trim() === '') {
      return { kind: 'abstain', reason: 'handoff without a target' }; // FAIL CLOSED
    }
    const reason = env['reason'];
    return {
      kind: 'handoff',
      handoff: {
        kind: 'handoff',
        target,
        reason: typeof reason === 'string' && reason !== '' ? reason : 'reasoner requested handoff',
      },
    };
  }

  if (action === 'abstain') {
    const reason = env['reason'];
    return {
      kind: 'abstain',
      reason: typeof reason === 'string' && reason !== '' ? reason : 'reasoner abstained',
    };
  }

  // Unknown action, non-string action, missing action — all land here.
  return { kind: 'abstain', reason: 'unknown reasoner action' };
}

/**
 * Extract the first balanced `{...}` from `text`, respecting JSON string
 * literals and escapes (a `}` inside a quoted string does not close the
 * object). Returns null when no balanced object exists — the caller abstains.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // Unbalanced — fail closed upstream.
}

/**
 * Validate and map the envelope's `citations` to core `Citation`s. Returns
 * null (→ abstain) unless it is a non-empty array whose EVERY item carries a
 * non-empty string `sourceId` and a non-empty string `quote`. One malformed
 * item poisons the whole answer — partial grounding is not grounding.
 */
function parseCitations(value: unknown): Citation[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: Citation[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const c = item as Readonly<Record<string, unknown>>;
    const sourceId = c['sourceId'];
    const quote = c['quote'];
    // `.trim()` (not bare `=== ''`) — a whitespace-only sourceId/quote is a
    // semantically-blank citation and must NOT satisfy the grounded-or-abstain
    // gate; matches the draft's own non-empty check. Fail-closed.
    if (typeof sourceId !== 'string' || sourceId.trim() === '') return null;
    if (typeof quote !== 'string' || quote.trim() === '') return null;
    const location = c['location'];
    out.push({
      sourceId,
      quote,
      ...(typeof location === 'string' && location !== '' ? { location } : {}),
    });
  }
  return out;
}

// ── buildSystem ─────────────────────────────────────────────────────────────

// FIRST-DRAFT prompt — efficacy UNVALIDATED against a real model (no model
// access at build time); fail-closed protects the guarantee regardless. Iterate
// on wording once a real model is wired in; do NOT loosen parseEnvelope to
// compensate for prompt weaknesses.
export function buildSystem(state: OrchestratorState): string {
  const chunks = state.chunks ?? [];
  const knowledge =
    chunks.length === 0
      ? '(no knowledge retrieved)'
      : chunks.map((c) => `[${c.source.id}] ${c.source.text}`).join('\n');

  return [
    'You are a grounded support agent. You decide ONE action per turn and, if answering, draft the reply in the same turn.',
    '',
    'PRINCIPLES (grounded-or-abstain):',
    '- Answer ONLY from the KNOWLEDGE block below. Never use outside knowledge, memory, or guesses.',
    '- Every answer MUST include at least one citation: the sourceId of a KNOWLEDGE entry plus a VERBATIM quote from that entry that backs the claim.',
    '- If the question cannot be answered from KNOWLEDGE, use action "abstain". Abstaining is correct behavior, not failure.',
    '- If the request needs a human or a specialist, use action "handoff" with a target.',
    '- Never invent facts, sources, quotes, numbers, or policies.',
    '',
    'KNOWLEDGE:',
    knowledge,
    '',
    'OUTPUT FORMAT:',
    'Respond with ONLY a JSON object (no prose, no markdown fences) of the shape:',
    '{"action":"answer|handoff|abstain","text":"...","citations":[{"sourceId":"...","quote":"..."}],"target":"...","reason":"..."}',
    '- action "answer": include "text" and a non-empty "citations" array.',
    '- action "handoff": include "target" and a "reason".',
    '- action "abstain": include a "reason".',
    'Include only the fields relevant to your action.',
  ].join('\n');
}
