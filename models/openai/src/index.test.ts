import { OpenAiChatModel, OpenAiApiError, type OpenAiHttp } from './index.js';
import { streamToString } from '@tenet/streaming';

const enc = new TextEncoder();

function bodyStream(...lines: string[]): ReadableStream<Uint8Array> {
  const data = lines.join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(data));
      controller.close();
    },
  });
}

function mockHttp(args: {
  status: number;
  text?: string;
  stream?: ReadableStream<Uint8Array>;
}): { http: OpenAiHttp; calls: Array<{ url: string; body: string; headers: Readonly<Record<string, string>> }> } {
  const calls: Array<{ url: string; body: string; headers: Readonly<Record<string, string>> }> = [];
  return {
    http: {
      async fetch(url, init) {
        calls.push({ url, body: init.body, headers: init.headers });
        return {
          status: args.status,
          text: async () => args.text ?? '',
          body: args.stream ?? null,
        };
      },
    },
    calls,
  };
}

describe('OpenAiChatModel — construction', () => {
  it('rejects missing apiKey/model', () => {
    const { http } = mockHttp({ status: 200 });
    expect(() => new OpenAiChatModel(http, { apiKey: '', model: 'm' })).toThrow();
    expect(() => new OpenAiChatModel(http, { apiKey: 'k', model: '' })).toThrow();
  });
  it('rejects out-of-range temperature', () => {
    const { http } = mockHttp({ status: 200 });
    expect(() => new OpenAiChatModel(http, { apiKey: 'k', model: 'm', temperature: 3 })).toThrow();
  });
});

describe('OpenAiChatModel.chat (non-streaming)', () => {
  it('sends auth + correct body shape', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    });
    const m = new OpenAiChatModel(http, { apiKey: 'sk-1', model: 'gpt-4o', organization: 'org-x' });
    const out = await m.chat({ system: 'sys', user: 'u', maxTokens: 100 });
    expect(out).toBe('hi');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-1');
    expect(calls[0]!.headers['openai-organization']).toBe('org-x');
    const body = JSON.parse(calls[0]!.body);
    expect(body.model).toBe('gpt-4o');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('throws OpenAiApiError on non-2xx', async () => {
    const { http } = mockHttp({ status: 401, text: 'unauthorized' });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'm' });
    await expect(m.chat({ system: 's', user: 'u', maxTokens: 1 })).rejects.toBeInstanceOf(OpenAiApiError);
  });

  it('rejects maxTokens <= 0', async () => {
    const { http } = mockHttp({ status: 200, text: '{}' });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'm' });
    await expect(m.chat({ system: 's', user: 'u', maxTokens: 0 })).rejects.toThrow();
  });

  it('returns empty string when message content missing', async () => {
    const { http } = mockHttp({ status: 200, text: JSON.stringify({ choices: [{ message: {} }] }) });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'm' });
    expect(await m.chat({ system: 's', user: 'u', maxTokens: 1 })).toBe('');
  });
});

describe('OpenAiChatModel.chatStream', () => {
  it('parses SSE deltas into text chunks', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const out = await streamToString(m.chatStream({ system: 's', user: 'u', maxTokens: 100 }));
    expect(out).toBe('Hello');
  });

  it('sets stream=true + include_usage in body', async () => {
    const { http, calls } = mockHttp({ status: 200, stream: bodyStream('data: [DONE]\n\n') });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const it = m.chatStream({ system: 's', user: 'u', maxTokens: 1 });
    // Consume to trigger fetch
    for await (const _ of it) { /* drain */ void _; }
    const body = JSON.parse(calls[0]!.body);
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
  });

  it('throws OpenAiApiError on non-2xx before streaming', async () => {
    const { http } = mockHttp({ status: 500, text: 'err' });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const it = m.chatStream({ system: 's', user: 'u', maxTokens: 1 });
    await expect((async () => { for await (const _ of it) void _; })()).rejects.toBeInstanceOf(OpenAiApiError);
  });

  it('emits message_stop with finish_reason', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const chunks = [];
    for await (const c of m.chatStream({ system: 's', user: 'u', maxTokens: 1 })) chunks.push(c);
    const stop = chunks.find((c) => c.kind === 'message_stop');
    expect(stop).toEqual({ kind: 'message_stop', stopReason: 'length' });
  });
});
