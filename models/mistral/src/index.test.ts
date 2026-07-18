import { MistralChatModel, MistralApiError, type MistralHttp } from './index.js';
import { streamToString } from '@tenet/streaming';
import {
  responseText,
  textMessage,
  type ChatRequest,
  type StreamChunk,
} from '@tenet/core';

const enc = new TextEncoder();
function bodyStream(...lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(lines.join(''))); c.close(); } });
}

function mockHttp(args: { status: number; text?: string; stream?: ReadableStream<Uint8Array> }): {
  http: MistralHttp; calls: Array<{ url: string; body: string; headers: Readonly<Record<string, string>> }>;
} {
  const calls: Array<{ url: string; body: string; headers: Readonly<Record<string, string>> }> = [];
  return {
    http: {
      async fetch(url, init) {
        calls.push({ url, body: init.body, headers: init.headers });
        return { status: args.status, text: async () => args.text ?? '', body: args.stream ?? null };
      },
    },
    calls,
  };
}

/** Canonical ChatRequest factory — signal is REQUIRED by the contract. */
function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: 's',
    messages: [textMessage('user', 'u')],
    maxTokens: 10,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('MistralChatModel', () => {
  it('rejects missing apiKey/model + out-of-range temperature', () => {
    const { http } = mockHttp({ status: 200 });
    expect(() => new MistralChatModel(http, { apiKey: '', model: 'm' })).toThrow();
    expect(() => new MistralChatModel(http, { apiKey: 'k', model: '' })).toThrow();
    expect(() => new MistralChatModel(http, { apiKey: 'k', model: 'm', temperature: 1.5 })).toThrow();
  });

  it('chat() returns canonical ChatResponse + uses Bearer auth + prepends system', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: 'bonjour' }, finish_reason: 'stop' }] }),
    });
    const m = new MistralChatModel(http, { apiKey: 'mst-1', model: 'mistral-large-latest' });
    const res = await m.chat(req());
    expect(res.content).toEqual([{ type: 'text', text: 'bonjour' }]);
    expect(responseText(res)).toBe('bonjour');
    expect(res.stopReason).toBe('end_turn');
    expect(calls[0]!.headers['authorization']).toBe('Bearer mst-1');
    const body = JSON.parse(calls[0]!.body);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('chat() maps finish_reason length → stopReason max_tokens + usage (was a bare string before 1.2b-i)', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: 'tronqué' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    const res = await m.chat(req());
    expect(res.stopReason).toBe('max_tokens');
    expect(responseText(res)).toBe('tronqué');
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
  });

  it('chat() maps Mistral-specific finish_reason model_length → max_tokens (a truncation, NOT default end_turn)', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: 'cut off' }, finish_reason: 'model_length' }],
      }),
    });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    const res = await m.chat(req());
    // If model_length fell through to the default, this would be 'end_turn' — masking the truncation.
    expect(res.stopReason).toBe('max_tokens');
  });

  it('chat() maps finish_reason content_filter → refusal (a filtered draft must abstain, not ship)', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: 'filtered' }, finish_reason: 'content_filter' }],
      }),
    });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    // Default fall-through would be 'end_turn' — shipping a content-filtered generation as clean.
    expect((await m.chat(req())).stopReason).toBe('refusal');
  });

  it('chat() throws on non-2xx', async () => {
    const { http } = mockHttp({ status: 429, text: 'rate' });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    await expect(m.chat(req({ maxTokens: 1 }))).rejects.toBeInstanceOf(MistralApiError);
  });

  it('chatStream parses SSE deltas + usage + [DONE]', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    expect(await streamToString(m.chatStream(req({ maxTokens: 1 })))).toBe('Hello');
  });

  it('chatStream emits message_stop with canonical stopReason max_tokens for finish_reason length (raw string leaked before 1.2b-i)', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    const chunks: StreamChunk[] = [];
    for await (const c of m.chatStream(req({ maxTokens: 1 }))) chunks.push(c);
    const stops = chunks.filter((c) => c.kind === 'message_stop');
    expect(stops).toEqual([{ kind: 'message_stop', stopReason: 'max_tokens' }]);
  });

  it('chatStream throws on non-2xx', async () => {
    const { http } = mockHttp({ status: 500, text: 'err' });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    await expect((async () => { for await (const _ of m.chatStream(req({ maxTokens: 1 }))) void _; })()).rejects.toBeInstanceOf(MistralApiError);
  });
});

describe('MistralApiError — secret scrubbing (a model error must never surface a credential)', () => {
  it('scrubs a Bearer token + authorization value from the message AND stored .body', () => {
    const e = new MistralApiError(
      401,
      'auth failed for Bearer mst-super-secret-key-abc123def456 with authorization: raw-token-xyz789',
    );
    expect(e.message).toContain('Bearer [redacted]');
    expect(e.message).not.toContain('mst-super-secret-key-abc123def456');
    expect(e.body).not.toContain('mst-super-secret-key-abc123def456');
    expect(e.body).not.toContain('raw-token-xyz789');
  });

  it('scrubs an api_key JSON field', () => {
    const e = new MistralApiError(400, '{"error":"bad request","api_key":"KEY0123456789abcdef"}');
    expect(e.message).not.toContain('KEY0123456789abcdef');
    expect(e.body).not.toContain('KEY0123456789abcdef');
    expect(e.body).toContain('[redacted]');
  });

  it('bounds the stored body to 200 chars', () => {
    const e = new MistralApiError(500, 'x'.repeat(500));
    expect(e.body.length).toBeLessThanOrEqual(200);
  });
});
