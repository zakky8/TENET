/**
 * Reference deployment: minimal community-bot composition.
 *
 * Wires:
 *   - WorkingMemory (from @tenet/memory) for per-conversation history.
 *   - A retriever providing ranked sources for the incoming message.
 *   - A ChatModel that drafts a response given system + user + sources.
 *   - The verifier (any callable conforming to the shape) to validate.
 *   - OutcomeEmitter (from @tenet/telemetry) to record the outcome.
 *
 * This is NOT a full agent runtime — it's a hand-wired composition
 * that shows how the framework pieces fit together. Production
 * deployments typically use a state-machine harness (Phase 2).
 */

import type {
  ChatModel,
  ChatRequest,
  ChatResponse,
  ConversationMessage,
  NormalizedEvent,
  NormalizedReply,
  Outcome,
  Source,
} from '@tenet/core';
import { textMessage, responseText } from '@tenet/core';

/** Minimal retriever signature — implement with @tenet/retrieval or any custom impl. */
export interface BotRetriever {
  query(args: { text: string; tenantId?: string }): Promise<ReadonlyArray<Source>>;
}

/** Canonical alias — community-bot now speaks the canonical ChatModel contract
 *  (structured messages, not the legacy single-string shape). */
export type BotChatModel = ChatModel;

export interface BotVerifier {
  verify(args: {
    sources: string;
    draft: string;
  }): Promise<{ pass: boolean; critique: string }>;
}

export interface BotMemory {
  append(message: ConversationMessage): void;
  messages(): ReadonlyArray<ConversationMessage>;
}

export interface BotTelemetry {
  record(args: {
    outcome: Outcome;
    conversationId: string;
    tenantId: string;
    durationMs: number;
    costUsd: number;
    verifierPassed: boolean | null;
    reason?: string;
  }): void;
}

export interface CommunityBotOptions {
  retriever: BotRetriever;
  model: BotChatModel;
  verifier: BotVerifier;
  memory: BotMemory;
  telemetry?: BotTelemetry;
  /** System prompt prefix (constitutional principles, etc.). */
  systemPrompt: string;
  /** Max tokens per draft. Default 1024. */
  maxTokens?: number;
  /**
   * Time source — injectable for tests. Default Date.now.
   */
  now?: () => number;
}

export class CommunityBot {
  private readonly maxTokens: number;
  private readonly now: () => number;

  constructor(private readonly opts: CommunityBotOptions) {
    this.maxTokens = opts.maxTokens ?? 1024;
    this.now = opts.now ?? (() => Date.now());
    if (!opts.systemPrompt) throw new Error('CommunityBot: systemPrompt required');
  }

  /**
   * Handle one inbound NormalizedEvent → returns a NormalizedReply.
   *
   * Pipeline:
   *   1. Append user message to memory
   *   2. Retrieve sources for the text
   *   3. Build prompt (system + history + sources + user)
   *   4. Call ChatModel for draft
   *   5. Verify against the assembled sources block
   *   6. If verifier fails → return abstain reply + record disqualified
   *   7. Otherwise → append assistant message, return reply with citations
   *      pointing at the matched sources
   */
  async handle(event: NormalizedEvent, signal?: AbortSignal): Promise<NormalizedReply> {
    const start = this.now();

    this.opts.memory.append({ role: 'user', content: event.text });

    const sources = await this.opts.retriever.query({
      text: event.text,
      tenantId: event.tenantId,
    });
    const sourcesBlock = sources.map((s, i) => `[${i + 1}] ${s.text}`).join('\n\n');

    const history = this.opts.memory.messages();
    const prior = history.slice(0, -1).slice(-10); // last 10 PRIOR turns; excludes the current user msg appended above
    const finalUser = `Sources:\n${sourcesBlock || '(none)'}\n\nQuestion: ${event.text}`;
    const messages = [...prior.map((m) => textMessage(m.role, m.content)), textMessage('user', finalUser)];

    let draft: string;
    try {
      const res = await this.opts.model.chat({
        system: this.opts.systemPrompt,
        messages,
        maxTokens: this.maxTokens,
        signal: signal ?? new AbortController().signal, // canonical requires signal; un-abortable fallback matches quickstart 1.3
      });
      draft = responseText(res);
    } catch (e) {
      this.recordOutcome(
        'disqualified',
        event,
        this.now() - start,
        null,
        `model error: ${(e as Error).message}`,
      );
      return {
        text: ABSTAIN_REPLY,
        citations: [],
      };
    }

    const verifyResult = await this.opts.verifier.verify({
      sources: sourcesBlock,
      draft,
    });

    if (!verifyResult.pass) {
      this.recordOutcome(
        'disqualified',
        event,
        this.now() - start,
        false,
        `verifier rejected: ${verifyResult.critique}`,
      );
      return {
        text: ABSTAIN_REPLY,
        citations: [],
      };
    }

    this.opts.memory.append({ role: 'assistant', content: draft });

    this.recordOutcome('resolved', event, this.now() - start, true);

    // Attach citations naively: one per source the retriever surfaced.
    // Apps that need precise per-claim attribution wire @tenet/verifier's
    // approvedCitations through here.
    return {
      text: draft,
      citations: sources.map((s) => ({
        sourceId: s.id,
        quote: s.text.slice(0, 240),
      })),
    };
  }

  private recordOutcome(
    outcome: Outcome,
    event: NormalizedEvent,
    durationMs: number,
    verifierPassed: boolean | null,
    reason?: string,
  ): void {
    if (!this.opts.telemetry) return;
    this.opts.telemetry.record({
      outcome,
      conversationId: event.conversationId,
      tenantId: event.tenantId,
      durationMs,
      costUsd: 0, // cost meter integration is Phase 2
      verifierPassed,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
}

const ABSTAIN_REPLY =
  "I don't have a confirmed answer for that — could you rephrase or provide more detail?";

export const VERSION = '0.0.0';
