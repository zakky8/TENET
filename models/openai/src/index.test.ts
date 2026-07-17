import { OpenAiChatModel, OpenAiApiError, type OpenAiHttp } from './index.js';
import { streamToString } from '@tenet/streaming';
import {
  responseText,
  textMessage,
  type ChatRequest,
  type StreamChunk,
} from '@tenet/core';

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

/** Canonical ChatRequest factory — signal is REQUIRED by the contract. */
function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: 'sys',
    messages: [textMessage('user', 'u')],
    maxTokens: 100,
    signal: new AbortController().signal,
    ...overrides,
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
  it('sends auth + correct body shape (system prepended)', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
    });
    const m = new OpenAiChatModel(http, { apiKey: 'sk-1', model: 'gpt-4o', organization: 'org-x' });
    const res = await m.chat(req());
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(responseText(res)).toBe('hi');
    expect(res.stopReason).toBe('end_turn');
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
    expect(body.tools).toBeUndefined();
  });

  it('omits the system message when req.system is empty', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'm' });
    await m.chat(req({ system: '' }));
    expect(JSON.parse(calls[0]!.body).messages).toEqual([{ role: 'user', content: 'u' }]);
  });

  it('maps finish_reason length → stopReason max_tokens + usage (was a bare string before 1.2b-i)', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const res = await m.chat(req());
    expect(res.stopReason).toBe('max_tokens');
    expect(responseText(res)).toBe('truncated');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('maps tool_calls → tool_use blocks + stopReason tool_use; maps req.tools onto wire', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
    });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const res = await m.chat(req({
      tools: [{ name: 'get_weather', description: 'Weather lookup', inputSchema: { type: 'object' } }],
    }));
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
    ]);
    expect(res.usage).toBeUndefined();
    expect(JSON.parse(calls[0]!.body).tools).toEqual([
      { type: 'function', function: { name: 'get_weather', description: 'Weather lookup', parameters: { type: 'object' } } },
    ]);
  });

  it('honors request temperature over the constructor default', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
    });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'm', temperature: 0.2 });
    await m.chat(req({ temperature: 0.9 }));
    expect(JSON.parse(calls[0]!.body).temperature).toBe(0.9);
  });

  it('throws OpenAiApiError on non-2xx', async () => {
    const { http } = mockHttp({ status: 401, text: 'unauthorized' });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'm' });
    await expect(m.chat(req())).rejects.toBeInstanceOf(OpenAiApiError);
  });

  it('rejects maxTokens <= 0', async () => {
    const { http } = mockHttp({ status: 200, text: '{}' });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'm' });
    await expect(m.chat(req({ maxTokens: 0 }))).rejects.toThrow();
  });

  it('returns empty content when message content missing', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({ choices: [{ message: {}, finish_reason: 'stop' }] }),
    });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'm' });
    const res = await m.chat(req({ maxTokens: 1 }));
    expect(res.content).toEqual([]);
    expect(responseText(res)).toBe('');
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
    const out = await streamToString(m.chatStream(req()));
    expect(out).toBe('Hello');
  });

  it('sets stream=true + include_usage in body', async () => {
    const { http, calls } = mockHttp({ status: 200, stream: bodyStream('data: [DONE]\n\n') });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const it = m.chatStream(req({ maxTokens: 1 }));
    // Consume to trigger fetch
    for await (const _ of it) { /* drain */ void _; }
    const body = JSON.parse(calls[0]!.body);
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
  });

  it('throws OpenAiApiError on non-2xx before streaming', async () => {
    const { http } = mockHttp({ status: 500, text: 'err' });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const it = m.chatStream(req({ maxTokens: 1 }));
    await expect((async () => { for await (const _ of it) void _; })()).rejects.toBeInstanceOf(OpenAiApiError);
  });

  it('emits message_stop with canonical stopReason max_tokens for finish_reason length (raw string leaked before 1.2b-i)', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const chunks: StreamChunk[] = [];
    for await (const c of m.chatStream(req({ maxTokens: 1 }))) chunks.push(c);
    const stops = chunks.filter((c) => c.kind === 'message_stop');
    expect(stops).toEqual([{ kind: 'message_stop', stopReason: 'max_tokens' }]);
  });

  it('emits usage chunk + defaults message_stop to end_turn when no finish_reason arrived', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { http } = mockHttp({ status: 200, stream: bodyStream(...sse) });
    const m = new OpenAiChatModel(http, { apiKey: 'k', model: 'gpt-4o' });
    const chunks: StreamChunk[] = [];
    for await (const c of m.chatStream(req({ maxTokens: 1 }))) chunks.push(c);
    expect(chunks).toContainEqual({ kind: 'usage', inputTokens: 7, outputTokens: 3 });
    expect(chunks[chunks.length - 1]).toEqual({ kind: 'message_stop', stopReason: 'end_turn' });
  });
});
