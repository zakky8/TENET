import { MistralChatModel, MistralApiError, type MistralHttp } from './index.js';
import { streamToString } from '@tenet/streaming';

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

describe('MistralChatModel', () => {
  it('rejects missing apiKey/model + out-of-range temperature', () => {
    const { http } = mockHttp({ status: 200 });
    expect(() => new MistralChatModel(http, { apiKey: '', model: 'm' })).toThrow();
    expect(() => new MistralChatModel(http, { apiKey: 'k', model: '' })).toThrow();
    expect(() => new MistralChatModel(http, { apiKey: 'k', model: 'm', temperature: 1.5 })).toThrow();
  });

  it('chat() returns content + uses Bearer auth', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: 'bonjour' } }] }),
    });
    const m = new MistralChatModel(http, { apiKey: 'mst-1', model: 'mistral-large-latest' });
    expect(await m.chat({ system: 's', user: 'u', maxTokens: 10 })).toBe('bonjour');
    expect(calls[0]!.headers['authorization']).toBe('Bearer mst-1');
    expect(JSON.parse(calls[0]!.body).stream).toBe(false);
  });

  it('chat() throws on non-2xx', async () => {
    const { http } = mockHttp({ status: 429, text: 'rate' });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    await expect(m.chat({ system: 's', user: 'u', maxTokens: 1 })).rejects.toBeInstanceOf(MistralApiError);
  });

  it('chatStream parses SSE deltas + finish_reason + usage + [DONE]', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    expect(await streamToString(m.chatStream({ system: 's', user: 'u', maxTokens: 1 }))).toBe('Hello');
  });

  it('chatStream throws on non-2xx', async () => {
    const { http } = mockHttp({ status: 500, text: 'err' });
    const m = new MistralChatModel(http, { apiKey: 'k', model: 'm' });
    await expect((async () => { for await (const _ of m.chatStream({ system: 's', user: 'u', maxTokens: 1 })) void _; })()).rejects.toBeInstanceOf(MistralApiError);
  });
});
