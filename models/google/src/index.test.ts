import { GoogleChatModel, GoogleApiError, type GoogleHttp } from './index.js';
import { streamToString } from '@tenet/streaming';

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
      text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
    });
    const m = new GoogleChatModel(http, { apiKey: 'sk-g', model: 'gemini-2.5-pro' });
    const out = await m.chat({ system: 'sys', user: 'q?', maxTokens: 100 });
    expect(out).toBe('hi');
    expect(calls[0]!.url).toContain('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('sk-g');
    const body = JSON.parse(calls[0]!.body);
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.contents[0].parts[0].text).toBe('q?');
    expect(body.generationConfig.maxOutputTokens).toBe(100);
  });

  it('throws GoogleApiError on non-2xx', async () => {
    const { http } = mockHttp({ status: 403, text: 'forbidden' });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'm' });
    await expect(m.chat({ system: 's', user: 'u', maxTokens: 1 })).rejects.toBeInstanceOf(GoogleApiError);
  });

  it('returns empty string when candidates is empty', async () => {
    const { http } = mockHttp({ status: 200, text: '{"candidates":[]}' });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'm' });
    expect(await m.chat({ system: 's', user: 'u', maxTokens: 1 })).toBe('');
  });

  it('joins multiple text parts', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }),
    });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'm' });
    expect(await m.chat({ system: 's', user: 'u', maxTokens: 1 })).toBe('ab');
  });

  it('encodes model id in URL', async () => {
    const { http, calls } = mockHttp({ status: 200, text: '{"candidates":[]}' });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'with/slash' });
    await m.chat({ system: 's', user: 'u', maxTokens: 1 });
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
    const out = await streamToString(m.chatStream({ system: 's', user: 'u', maxTokens: 100 }));
    expect(out).toBe('Hello');
  });

  it('emits stop with FINISH reason but skips UNSPECIFIED', async () => {
    const sse = [
      'data: {"candidates":[{"finishReason":"FINISH_REASON_UNSPECIFIED"}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"x"}]}}]}\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'g' });
    const chunks = [];
    for await (const c of m.chatStream({ system: 's', user: 'u', maxTokens: 1 })) chunks.push(c);
    const stops = chunks.filter((c) => c.kind === 'message_stop');
    expect(stops).toHaveLength(1);
    expect((stops[0] as { stopReason: string }).stopReason).toBe('STOP');
  });

  it('throws on non-2xx before streaming', async () => {
    const { http } = mockHttp({ status: 500, text: 'err' });
    const m = new GoogleChatModel(http, { apiKey: 'k', model: 'g' });
    const it = m.chatStream({ system: 's', user: 'u', maxTokens: 1 });
    await expect((async () => { for await (const _ of it) void _; })()).rejects.toBeInstanceOf(GoogleApiError);
  });
});
