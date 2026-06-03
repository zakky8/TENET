/**
 * Foundational types for the TENET agent platform.
 * Every package depends on these. They are intentionally minimal and
 * intentionally typed to make CVE-class mistakes impossible at the type
 * level: no `any` fields, no raw paths, no free-form deserialization.
 */

// ── Opaque types — block accidental misuse at the type level ────────────────

const SecretBrand: unique symbol = Symbol('SecretBrand');
/** Opaque secret. Never serialized via JSON.stringify — its toJSON throws. */
export class Secret<T = string> {
  readonly [SecretBrand] = true;
  constructor(private readonly value: T) {}
  reveal(): T {
    return this.value;
  }
  toJSON(): never {
    throw new Error('Secret<T> cannot be serialized');
  }
  toString(): string {
    return '[Secret]';
  }
}

const PathHandleBrand: unique symbol = Symbol('PathHandleBrand');
/**
 * A path that has been opened against an allowlist root.
 * The only way to construct one is via the fs module's openPath() helper
 * which validates against the per-process root. Raw strings are rejected
 * at the type level — code that wants to do file I/O cannot accidentally
 * pass a user-controlled string.
 */
export interface PathHandle {
  readonly [PathHandleBrand]: true;
  readonly absolute: string;
}

// ── Conversation events ─────────────────────────────────────────────────────

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationMessage {
  role: Role;
  content: string;
  /** Tool-call results (when role === 'tool'). */
  toolCallId?: string;
  /** Citations attached to the message (when role === 'assistant'). */
  citations?: Citation[];
  /** Optional surface-specific metadata. Surfaces own this namespace. */
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface Citation {
  /** Reference to a Source.id from the retrieval pipeline. */
  sourceId: string;
  /** Verbatim quote from the source backing this claim. */
  quote: string;
  /** Optional location (page, section, line range). */
  location?: string;
}

export interface Source {
  /** Stable, content-addressable id (e.g. sha256 of chunk text). */
  id: string;
  /** Original URL or filesystem reference. Never displayed without verification. */
  uri: string;
  /** Verbatim chunk text — what the model is allowed to ground on. */
  text: string;
  /** Confidence the source itself is correct (0..1). Low confidence → verifier downgrades to "I'm not sure". */
  confidence: number;
  /** Free-form metadata controlled by the indexing pipeline. */
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

// ── Surface (chat/ticketing/web adapter) ────────────────────────────────────

export interface NormalizedEvent {
  /** Surface name (e.g. 'telegram', 'discord', 'slack'). */
  surface: string;
  /** Stable tenant ID — used for per-tenant rate-limit + retrieval scoping. */
  tenantId: string;
  /** Stable conversation/channel/thread ID within the surface. */
  conversationId: string;
  /** Stable user ID within the surface. */
  userId: string;
  /** Verbatim user text. */
  text: string;
  /** Surface-native event time (UTC ms). */
  receivedAt: number;
  /** Optional inbound attachments. */
  attachments?: ReadonlyArray<Attachment>;
  /** Optional surface metadata. */
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface Attachment {
  kind: 'image' | 'audio' | 'video' | 'document' | 'other';
  uri: string;
  /** Bytes — undefined for streamed/external. */
  size?: number;
  mime?: string;
}

export interface NormalizedReply {
  text: string;
  /** Citations the verifier produced/approved. */
  citations: ReadonlyArray<Citation>;
  /** Surface-suggested formatting hints. The formatter has the final say. */
  formattingHints?: {
    bold?: ReadonlyArray<[number, number]>;
    code?: ReadonlyArray<[number, number]>;
    links?: ReadonlyArray<{ start: number; end: number; href: string }>;
  };
  /** Outbound attachments (e.g. generated images, file references). */
  attachments?: ReadonlyArray<Attachment>;
  /** Suggested follow-up actions (e.g. quick replies, buttons). */
  actions?: ReadonlyArray<ReplyAction>;
}

export type ReplyAction =
  | { kind: 'quick_reply'; label: string; payload: string }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'escalate'; label: string; targetTeam: string };

// ── Outcomes (first-class telemetry primitive) ──────────────────────────────

export type Outcome =
  | 'resolved'
  | 'handed_off'
  | 'disqualified'
  | 'qualified'
  | 'pending';

export interface OutcomeEvent {
  outcome: Outcome;
  conversationId: string;
  tenantId: string;
  /** ms since conversation start to this outcome. */
  durationMs: number;
  /** Total cost spent on this conversation (USD). */
  costUsd: number;
  /** Verifier verdict for the final reply (null if no reply was emitted). */
  verifierPassed: boolean | null;
  /** Free-form reason — usually the routing decision that led here. */
  reason?: string;
}

// ── Agent state machine ─────────────────────────────────────────────────────

export interface AgentState {
  event: NormalizedEvent;
  /** Past turns in this conversation, capped by memory policy. */
  history: ReadonlyArray<ConversationMessage>;
  /** Classifier result — pure regex/keyword, no LLM call. */
  intent: string;
  /** Retrieved sources after hybrid + rerank. Stable id order. */
  sources: ReadonlyArray<Source>;
  /** Draft from the generator (pre-verification). */
  draft?: string;
  /** Citations the generator attached to the draft. */
  draftCitations?: ReadonlyArray<Citation>;
  /** Verifier critique on a failed verify — drives one retry. */
  critique?: string;
  /** Number of generate→verify retries already attempted. Capped at maxRetries. */
  attempts: number;
  /** Final outcome (set on terminal node). */
  outcome?: Outcome;
}

// ── Filter — parameterized query primitive ──────────────────────────────────

/**
 * Typed filter for store queries. Store adapters take this — never a raw
 * string — so SQL injection (LangChain CVE-2025-67644) cannot happen.
 */
export interface Filter<TKey extends string = string> {
  readonly key: TKey;
  readonly op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
  readonly value: string | number | boolean | ReadonlyArray<string | number>;
}

/**
 * Validates a metadata-filter key is safe to inject into a store query.
 * Rejects:
 *   - any char outside [a-zA-Z0-9_.-]
 *   - "--" anywhere (SQL line-comment injection — would end the original filter)
 *   - ".." anywhere (path traversal if the key is later used in a path context)
 */
const FILTER_KEY_RE = /^[a-zA-Z0-9_.-]+$/;
export function validateFilterKey(key: string): void {
  if (!FILTER_KEY_RE.test(key) || key.includes('--') || key.includes('..')) {
    throw new Error(`Invalid filter key: ${JSON.stringify(key.slice(0, 32))}`);
  }
}

// ── Errors with stable error codes ──────────────────────────────────────────

export type TenetErrorCode =
  | 'VERIFIER_FAILED'
  | 'RETRIEVAL_FAILED'
  | 'MODEL_FAILED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'INVALID_INPUT'
  | 'PERMISSION_DENIED'
  | 'INTERNAL';

export class TenetError extends Error {
  constructor(
    public readonly code: TenetErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TenetError';
  }
}
