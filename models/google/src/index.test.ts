import { GoogleChatModel, GoogleApiError, type GoogleHttp } from './index.js';
import { streamToString } from '@tenet/streaming';
import {
  responseText,
  textMessage,
  type ChatRequest,
  type StreamChunk,
} from '@tenet/core';

const enc = new TextEncoder();
function bodyStream(...lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(lines.join(''))); c.close(); },
  });
}

function mockHttp(args: { status: number; text?: string; stream?: ReadableStream<Uint8Array> }): {
  http: GoogleHttp; calls: Array<{ url: string; body: string; headers: Readonly<Record<string, string>> }>;
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
    maxTokens: 1,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('GoogleChatModel construction', () => {
  it('rejects missing apiKey/model', () => {
    const { http } = mockHttp({ status: 200 });
    expect(() => new GoogleChatModel(http, { apiKey: '', model: 'm' })).toThrow();
    expect(() => new GoogleChatModel(http, { apiKey: 'k', model: '' })).toThrow();
  });

  it('rejects out-of-range temperature', () => {
    const { http } = mockHttp({ status: 200 });
    expect(() => new GoogleChatModel(http, { apiKey: 'k', model: 'm', temperature: 3 })).toThrow();
  });
});

describe('GoogleChatModel.chat', () => {
  it('builds correct body shape + x-goog-api-key header', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
    });
    const m = new GoogleChatModel(http, { apiKey: 'sk-g', model: 'gemini-2.5-pro' });
    const res = await m.chat(req({ system: 'sys', messages: [textMessage('user', 'q?')], maxTokens: 100 }));
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(responseText(res)).toBe('hi');
    expect(res.stopReason).toBe('end_turn');
    expect(calls[0]!.url).toContain('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('sk-g');
    const body = JSON.parse(calls[0]!.body);
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'q?' }] }]);
    expect(body.generationConfig.maxOutputTokens).toBe(100);
  });

  it('maps assistant turns to Gemini role "model" and omits empty systemInstruction', async () => {
    const { http, calls } = mockHttp({ status: 200, text: '{"candidates":[]}' });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'g' });
    await m.chat(req({
      system: '',
      messages: [textMessage('user', 'hi'), textMessage('assistant', 'hello'), textMessage('user', 'more')],
    }));
    const body = JSON.parse(calls[0]!.body);
    expect(body.systemInstruction).toBeUndefined();
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
  });

  it('maps finishReason MAX_TOKENS → stopReason max_tokens + usage (was a bare string before 1.2b-ii)', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'truncated' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'g' });
    const res = await m.chat(req());
    expect(res.stopReason).toBe('max_tokens');
    expect(responseText(res)).toBe('truncated');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('maps finishReason SAFETY → stopReason refusal', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }),
    });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'g' });
    const res = await m.chat(req());
    expect(res.stopReason).toBe('refusal');
    expect(res.content).toEqual([]);
  });

  it('maps finishReason PROHIBITED_CONTENT → stopReason refusal (a block, NOT masked as end_turn)', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }),
    });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'g' });
    const res = await m.chat(req());
    // Without the extra block-reason cases this would fall to the default 'end_turn',
    // reporting a content-blocked generation as a clean stop.
    expect(res.stopReason).toBe('refusal');
  });

  it('throws GoogleApiError on non-2xx', async () => {
    const { http } = mockHttp({ status: 403, text: 'forbidden' });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'm' });
    await expect(m.chat(req())).rejects.toBeInstanceOf(GoogleApiError);
  });

  it('returns empty content when candidates is empty', async () => {
    const { http } = mockHttp({ status: 200, text: '{"candidates":[]}' });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'm' });
    const res = await m.chat(req());
    expect(res.content).toEqual([]);
    expect(responseText(res)).toBe('');
    expect(res.stopReason).toBe('end_turn');
  });

  it('joins multiple text parts', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }),
    });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'm' });
    expect(responseText(await m.chat(req()))).toBe('ab');
  });

  it('encodes model id in URL', async () => {
    const { http, calls } = mockHttp({ status: 200, text: '{"candidates":[]}' });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'with/slash' });
    await m.chat(req());
    expect(calls[0]!.url).toContain('with%2Fslash');
  });
});

describe('GoogleChatModel.chatStream', () => {
  it('parses SSE deltas + usage + finishReason', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}]}\n\n',
      'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'gemini-2.5-flash' });
    const out = await streamToString(m.chatStream(req({ maxTokens: 100 })));
    expect(out).toBe('Hello');
  });

  it('skips UNSPECIFIED and emits exactly one canonical message_stop at stream end', async () => {
    const sse = [
      'data: {"candidates":[{"finishReason":"FINISH_REASON_UNSPECIFIED"}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"x"}]}}]}\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'g' });
    const chunks: StreamChunk[] = [];
    for await (const c of m.chatStream(req())) chunks.push(c);
    const stops = chunks.filter((c) => c.kind === 'message_stop');
    expect(stops).toEqual([{ kind: 'message_stop', stopReason: 'end_turn' }]);
    expect(chunks[chunks.length - 1]).toEqual({ kind: 'message_stop', stopReason: 'end_turn' });
  });

  it('emits single message_stop max_tokens for finishReason MAX_TOKENS (raw MAX_TOKENS leaked before 1.2b-ii)', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"MAX_TOKENS"}]}\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'g' });
    const chunks: StreamChunk[] = [];
    for await (const c of m.chatStream(req())) chunks.push(c);
    const stops = chunks.filter((c) => c.kind === 'message_stop');
    expect(stops).toEqual([{ kind: 'message_stop', stopReason: 'max_tokens' }]);
  });

  it('throws on non-2xx before streaming', async () => {
    const { http } = mockHttp({ status: 500, text: 'err' });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'g' });
    const it = m.chatStream(req());
    await expect((async () => { for await (const _ of it) void _; })()).rejects.toBeInstanceOf(GoogleApiError);
  });
});
