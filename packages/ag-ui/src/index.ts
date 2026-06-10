/**
 * @tenet/ag-ui — AG-UI protocol adapter.
 *
 * AG-UI is the event-based agent↔frontend contract that became the
 * 2026 de-facto standard for streaming agent UIs (adopted by AWS
 * Bedrock AgentCore Runtime, Microsoft Agent Framework, LangGraph,
 * CrewAI, Pydantic-AI integrations). A frontend that speaks AG-UI
 * renders ANY compliant agent: text streaming, tool orchestration,
 * shared state, lifecycle.
 *
 * Three layers here:
 *   1. Typed event union (the protocol's ~16 event types).
 *   2. AgUiRunEmitter — lifecycle-enforcing builder: guards illegal
 *      sequences (content before start, two active messages, events
 *      after finish) at the source instead of corrupting the UI.
 *   3. streamChunksToAgUi — bridge from @tenet/streaming StreamChunk,
 *      so every streaming ChatModel adapter (Anthropic, OpenAI,
 *      Gemini, Mistral, Ollama, Bedrock) drives an AG-UI frontend
 *      without bespoke glue. Plus encodeSse() for the wire.
 */

// ── Event types ───────────────────────────────────────────────────────

export type AgUiEvent =
  // Run lifecycle
  | { type: 'RUN_STARTED'; threadId: string; runId: string }
  | { type: 'RUN_FINISHED'; threadId: string; runId: string; result?: unknown }
  | { type: 'RUN_ERROR'; message: string; code?: string }
  // Optional step grouping
  | { type: 'STEP_STARTED'; stepName: string }
  | { type: 'STEP_FINISHED'; stepName: string }
  // Assistant text streaming
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
  // Tool call streaming
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string; parentMessageId?: string }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string }
  | { type: 'TOOL_CALL_RESULT'; toolCallId: string; messageId: string; content: string }
  // Shared state
  | { type: 'STATE_SNAPSHOT'; snapshot: unknown }
  | { type: 'STATE_DELTA'; delta: JsonPatchOp[] }
  | { type: 'MESSAGES_SNAPSHOT'; messages: AgUiMessage[] }
  // Escape hatches
  | { type: 'RAW'; event: unknown; source?: string }
  | { type: 'CUSTOM'; name: string; value: unknown };

/** RFC 6902 JSON Patch operation (STATE_DELTA payload). */
export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

export interface AgUiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

// ── SSE wire encoding ─────────────────────────────────────────────────

/** Encode one event as an SSE frame (`data: <json>\n\n`). */
export function encodeSse(event: AgUiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Encode an event stream into SSE frames. */
export async function* encodeSseStream(
  events: AsyncIterable<AgUiEvent>,
): AsyncIterable<string> {
  for await (const ev of events) yield encodeSse(ev);
}

// ── Lifecycle-enforcing emitter ───────────────────────────────────────

export class AgUiProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgUiProtocolError';
  }
}

export interface AgUiSink {
  (event: AgUiEvent): void;
}

/**
 * Stateful per-run emitter. Enforces the protocol's sequencing rules
 * so a buggy agent can't emit a stream the frontend can't render:
 *   - exactly one RUN_STARTED, first
 *   - no events after RUN_FINISHED / RUN_ERROR
 *   - TEXT_MESSAGE_CONTENT only inside an open message
 *   - one open text message at a time (interleave via tool calls)
 *   - TOOL_CALL_ARGS/END only inside an open tool call
 */
export class AgUiRunEmitter {
  private started = false;
  private finished = false;
  private openMessageId: string | null = null;
  private readonly openToolCalls = new Set<string>();
  private seq = 0;

  constructor(
    private readonly sink: AgUiSink,
    private readonly ids: { threadId: string; runId: string },
  ) {}

  private emit(ev: AgUiEvent): void {
    if (this.finished) {
      throw new AgUiProtocolError(`event ${ev.type} after run finished`);
    }
    if (!this.started && ev.type !== 'RUN_STARTED') {
      throw new AgUiProtocolError(`event ${ev.type} before RUN_STARTED`);
    }
    this.sink(ev);
  }

  start(): void {
    if (this.started) throw new AgUiProtocolError('RUN_STARTED emitted twice');
    this.started = true;
    this.sink({ type: 'RUN_STARTED', threadId: this.ids.threadId, runId: this.ids.runId });
  }

  finish(result?: unknown): void {
    if (this.openMessageId !== null) this.endMessage();
    for (const id of [...this.openToolCalls]) this.endToolCall(id);
    this.emit({
      type: 'RUN_FINISHED', threadId: this.ids.threadId, runId: this.ids.runId,
      ...(result !== undefined ? { result } : {}),
    });
    this.finished = true;
  }

  error(message: string, code?: string): void {
    this.emit({ type: 'RUN_ERROR', message, ...(code !== undefined ? { code } : {}) });
    this.finished = true;
  }

  startStep(stepName: string): void {
    this.emit({ type: 'STEP_STARTED', stepName });
  }

  finishStep(stepName: string): void {
    this.emit({ type: 'STEP_FINISHED', stepName });
  }

  /** Open an assistant text message; returns its id. */
  startMessage(messageId?: string): string {
    if (this.openMessageId !== null) {
      throw new AgUiProtocolError('a text message is already open; end it first');
    }
    const id = messageId ?? `msg_${this.ids.runId}_${this.seq++}`;
    this.emit({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' });
    this.openMessageId = id;
    return id;
  }

  content(delta: string): void {
    if (this.openMessageId === null) {
      throw new AgUiProtocolError('TEXT_MESSAGE_CONTENT outside an open message');
    }
    if (delta.length === 0) return; // empty deltas are protocol noise
    this.emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: this.openMessageId, delta });
  }

  endMessage(): void {
    if (this.openMessageId === null) {
      throw new AgUiProtocolError('TEXT_MESSAGE_END without an open message');
    }
    this.emit({ type: 'TEXT_MESSAGE_END', messageId: this.openMessageId });
    this.openMessageId = null;
  }

  startToolCall(toolCallId: string, toolCallName: string): void {
    if (this.openToolCalls.has(toolCallId)) {
      throw new AgUiProtocolError(`tool call '${toolCallId}' already open`);
    }
    const ev: AgUiEvent = {
      type: 'TOOL_CALL_START', toolCallId, toolCallName,
      ...(this.openMessageId !== null ? { parentMessageId: this.openMessageId } : {}),
    };
    this.emit(ev);
    this.openToolCalls.add(toolCallId);
  }

  toolCallArgs(toolCallId: string, delta: string): void {
    if (!this.openToolCalls.has(toolCallId)) {
      throw new AgUiProtocolError(`TOOL_CALL_ARGS for unopened tool call '${toolCallId}'`);
    }
    this.emit({ type: 'TOOL_CALL_ARGS', toolCallId, delta });
  }

  endToolCall(toolCallId: string): void {
    if (!this.openToolCalls.has(toolCallId)) {
      throw new AgUiProtocolError(`TOOL_CALL_END for unopened tool call '${toolCallId}'`);
    }
    this.emit({ type: 'TOOL_CALL_END', toolCallId });
    this.openToolCalls.delete(toolCallId);
  }

  toolCallResult(toolCallId: string, content: string): void {
    this.emit({
      type: 'TOOL_CALL_RESULT', toolCallId,
      messageId: `msg_${this.ids.runId}_${this.seq++}`, content,
    });
  }

  stateSnapshot(snapshot: unknown): void {
    this.emit({ type: 'STATE_SNAPSHOT', snapshot });
  }

  stateDelta(delta: JsonPatchOp[]): void {
    this.emit({ type: 'STATE_DELTA', delta });
  }

  custom(name: string, value: unknown): void {
    this.emit({ type: 'CUSTOM', name, value });
  }
}

// ── StreamChunk bridge ────────────────────────────────────────────────

/** Structural copy of @tenet/streaming StreamChunk (type-compat). */
export type StreamChunkLike =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_use_delta'; id: string; partial: string }
  | { kind: 'tool_use_end'; id: string }
  | { kind: 'message_stop'; stopReason: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };

/**
 * Bridge a streaming ChatModel's chunks into a full AG-UI run:
 * RUN_STARTED → TEXT_MESSAGE_* / TOOL_CALL_* → RUN_FINISHED, with
 * RUN_ERROR on throw. Usage totals surface as a CUSTOM event
 * ('tenet.usage') so cost UIs get them without a protocol extension.
 */
export async function* streamChunksToAgUi(
  chunks: AsyncIterable<StreamChunkLike>,
  ids: { threadId: string; runId: string },
): AsyncIterable<AgUiEvent> {
  const out: AgUiEvent[] = [];
  const emitter = new AgUiRunEmitter((ev) => out.push(ev), ids);
  const flush = function* (): Generator<AgUiEvent> {
    while (out.length > 0) yield out.shift()!;
  };

  emitter.start();
  yield* flush();

  let stopReason: string | undefined;
  let messageOpen = false;
  try {
    for await (const chunk of chunks) {
      switch (chunk.kind) {
        case 'text': {
          // Lazily open the message on first non-empty text.
          if (chunk.text.length > 0) {
            if (!messageOpen) {
              emitter.startMessage();
              messageOpen = true;
            }
            emitter.content(chunk.text);
          }
          break;
        }
        case 'tool_use_start':
          emitter.startToolCall(chunk.id, chunk.name);
          break;
        case 'tool_use_delta':
          emitter.toolCallArgs(chunk.id, chunk.partial);
          break;
        case 'tool_use_end':
          emitter.endToolCall(chunk.id);
          break;
        case 'usage':
          emitter.custom('tenet.usage', {
            inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens,
          });
          break;
        case 'message_stop':
          stopReason = chunk.stopReason;
          break;
      }
      yield* flush();
    }
    emitter.finish(stopReason !== undefined ? { stopReason } : undefined);
    yield* flush();
  } catch (err) {
    if (err instanceof AgUiProtocolError) throw err;
    emitter.error(err instanceof Error ? err.message : String(err));
    yield* flush();
  }
}

export const VERSION = '0.0.0';
