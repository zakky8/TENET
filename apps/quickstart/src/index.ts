/**
 * Quickstart agent — the smallest REAL composition of the framework:
 * retrieve (BM25) → draft (any ChatModel) → verify (atomic-claim
 * multi-judge) → answer with citations or abstain.
 *
 * Runs with ZERO keys via StubChatModel (deterministic, offline) so
 * `pnpm quickstart` works the minute you clone. Set ANTHROPIC_API_KEY
 * and the same pipeline runs against a real model — see main.ts.
 */

import type { ChatRequest, ChatResponse, Source } from '@tenet/core';
import { responseText, textMessage } from '@tenet/core';
import { Bm25Index } from '@tenet/retrieval';
import { defaultPreChecks, verifyDraft, type ChatModel } from '@tenet/verifier';

// ── Bundled knowledge base (the agent answers questions about TENET) ──

export const QUICKSTART_KB: Source[] = [
  {
    id: 'kb-what',
    uri: 'docs/README.md#what',
    text: 'TENET is a verification-first TypeScript agent framework. Every draft answer is split into atomic claims and each claim is judged against retrieved sources before the user sees it. Unsupported claims mean the agent abstains instead of hallucinating.',
    confidence: 1,
  },
  {
    id: 'kb-verifier',
    uri: 'docs/ARCHITECTURE.md#verifier',
    text: 'The TENET verifier extracts atomic claims from a draft, then runs a strict judge and a permissive judge over each claim. A claim passes verification only when judged SUPPORTED against the source text.',
    confidence: 1,
  },
  {
    id: 'kb-governance',
    uri: 'docs/ARCHITECTURE.md#governance',
    text: 'TENET governance evaluates every tool call against policy rules before execution. Rules can allow, deny, or require human approval, and every decision is written to a structured audit trail.',
    confidence: 1,
  },
  {
    id: 'kb-durable',
    uri: 'packages/durable/README.md',
    text: 'The @tenet/durable package provides step-level durable execution. Completed steps are journaled and replayed deterministically, and interrupt() suspends a run for human approval across process restarts.',
    confidence: 1,
  },
  {
    id: 'kb-surfaces',
    uri: 'docs/README.md#surfaces',
    text: 'One TENET agent serves Discord, Slack, Telegram, Microsoft Teams, an embeddable web widget, REST, gRPC, Matrix, voice over Twilio, and ticketing systems including Zendesk, Intercom, Freshdesk, and ServiceNow.',
    confidence: 1,
  },
  {
    id: 'kb-interop',
    uri: 'docs/README.md#interop',
    text: 'TENET speaks the open agent protocols: MCP for tools with an OAuth gateway, A2A for agent-to-agent tasks, AG-UI for streaming frontends, and ACP for editor integration with Zed-class clients.',
    confidence: 1,
  },
];

// ── Deterministic stub model (zero keys, offline) ─────────────────────

/**
 * Routes on the verifier's own prompt markers (the same contract the
 * verifier test-suite uses), so the FULL pipeline — draft, claim
 * extraction, strict + permissive judging — runs offline:
 *   - claim-extraction prompts → first sentence of the draft
 *   - judge prompts            → '[1] SUPPORTED'
 *   - anything else (drafting) → answer composed from the KNOWLEDGE block
 */
/** Extract the flattened text of a canonical request's message content —
 *  the wire shape carries an array of blocks per message, but every caller
 *  in this app sends a single text block, so a responseText-style flatten
 *  reconstructs the same string the legacy `args.user` used to be. */
function requestUserText(req: ChatRequest): string {
  return req.messages
    .flatMap((m) => m.content)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}

function textResponse(text: string): ChatResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

export class StubChatModel implements ChatModel {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const user = requestUserText(req);
    if (req.system.includes('extract atomic')) {
      const firstSentence = user.split(/(?<=\.)\s/)[0] ?? user;
      return textResponse(firstSentence.slice(0, 200));
    }
    if (req.system.toLowerCase().includes('judge')) {
      return textResponse('[1] SUPPORTED');
    }
    // Draft request: ground the reply in the first KNOWLEDGE chunk.
    const m = user.match(/KNOWLEDGE:\n([\s\S]*?)(?:\n\n|$)/);
    const firstChunk = m?.[1]?.split('\n')[0] ?? 'I do not have enough information.';
    return textResponse(firstChunk);
  }
}

// ── The agent ─────────────────────────────────────────────────────────

export interface QuickstartAnswer {
  answer: string;
  verified: boolean;
  citations: string[];
  abstained: boolean;
}

export const ABSTAIN_REPLY =
  "I can't back that up with my sources, so I'd rather not guess.";

export interface QuickstartAgentOptions {
  model: ChatModel;
  /** Override the knowledge base (defaults to the bundled TENET docs). */
  kb?: Source[];
  topK?: number;
}

export class QuickstartAgent {
  private readonly model: ChatModel;
  private readonly index: Bm25Index;
  private readonly kb: Source[];
  private readonly topK: number;

  constructor(opts: QuickstartAgentOptions) {
    this.model = opts.model;
    this.kb = opts.kb ?? QUICKSTART_KB;
    this.topK = opts.topK ?? 3;
    this.index = new Bm25Index();
    this.index.upsert(this.kb.map((source) => ({ source })));
  }

  async ask(question: string, signal?: AbortSignal): Promise<QuickstartAnswer> {
    if (!question.trim()) {
      return { answer: 'Ask me something about TENET.', verified: false, citations: [], abstained: false };
    }

    // 1. Retrieve.
    const hits = this.index.query({ text: question, k: this.topK });
    const sources = hits.map((h) => h.source);
    const knowledge = sources.map((s) => s.text).join('\n');

    // 2. Draft, grounded on the KNOWLEDGE block.
    const draft = responseText(
      await this.model.chat({
        system:
          'Answer using ONLY the KNOWLEDGE block. If the knowledge does not contain the answer, say you do not know.',
        messages: [textMessage('user', `KNOWLEDGE:\n${knowledge}\n\nQUESTION: ${question}`)],
        maxTokens: 512,
        // Canonical ChatRequest.signal is required; synthesize an
        // un-abortable one when the caller passed none (a caller with no
        // signal never had cancellation here either, so this is parity).
        signal: signal ?? new AbortController().signal,
      }),
    );

    // 3. Verify every atomic claim in the draft against the sources.
    // The deterministic tier (P16) settles verbatim quotes and
    // fabricated numbers before any LLM judge call.
    const verdict = await verifyDraft(this.model, {
      sources: knowledge,
      sourceRecords: sources,
      draft,
    }, { claimPreChecks: defaultPreChecks() });

    if (!verdict.pass) {
      return { answer: ABSTAIN_REPLY, verified: false, citations: [], abstained: true };
    }
    const uriById = new Map(this.kb.map((s) => [s.id, s.uri]));
    const citations = [...new Set(
      verdict.approvedCitations
        .map((c) => uriById.get(c.sourceId))
        .filter((u): u is string => u !== undefined),
    )];
    return { answer: draft, verified: true, citations, abstained: false };
  }
}
