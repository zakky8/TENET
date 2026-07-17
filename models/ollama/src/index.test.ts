import { OllamaChatModel, OllamaApiError, type OllamaHttp } from './index.js';
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
  http: OllamaHttp; calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  return {
    http: {
      async fetch(url, init) {
        calls.push({ url, body: init.body });
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

describe('OllamaChatModel', () => {
  it('rejects missing model + bad temperature', () => {
    const { http } = mockHttp({ status: 200 });
    expect(() => new OllamaChatModel(http, { model: '' })).toThrow();
    expect(() => new OllamaChatModel(http, { model: 'm', temperature: -1 })).toThrow();
  });

  it('chat() returns content blocks + targets localhost:11434 default', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({ message: { content: 'hello' }, done_reason: 'stop' }),
    });
    const m = new OllamaChatModel(http, { model: 'llama3.3' });
    const res = await m.chat(req({ maxTokens: 10 }));
    expect(res.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(responseText(res)).toBe('hello');
    expect(res.stopReason).toBe('end_turn');
    expect(calls[0]!.url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(calls[0]!.body);
    expect(body.model).toBe('llama3.3');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(10);
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('chat() maps done_reason length → stopReason max_tokens + usage (was a bare string before 1.2b-ii)', async () => {
    const { http } = mockHttp({
      status: 200,
      text: JSON.stringify({
        message: { content: 'truncated' },
        done: true,
        done_reason: 'length',
        prompt_eval_count: 9,
        eval_count: 3,
      }),
    });
    const m = new OllamaChatModel(http, { model: 'm' });
    const res = await m.chat(req());
    expect(res.stopReason).toBe('max_tokens');
    expect(responseText(res)).toBe('truncated');
    expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
  });

  it('chat() omits system message when req.system is empty', async () => {
    const { http, calls } = mockHttp({ status: 200, text: '{"message":{"content":""}}' });
    const m = new OllamaChatModel(http, { model: 'm' });
    await m.chat(req({ system: '' }));
    expect(JSON.parse(calls[0]!.body).messages).toEqual([{ role: 'user', content: 'u' }]);
  });

  it('chat() throws OllamaApiError on non-2xx', async () => {
    const { http } = mockHttp({ status: 503, text: 'down' });
    const m = new OllamaChatModel(http, { model: 'm' });
    await expect(m.chat(req())).rejects.toBeInstanceOf(OllamaApiError);
  });

  it('chatStream() parses NDJSON + emits text + done', async () => {
    const ndjson =
      JSON.stringify({ message: { content: 'Hel' } }) + '\n' +
      JSON.stringify({ message: { content: 'lo' } }) + '\n' +
      JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }) + '\n';
    const { http } = mockHttp({ status: 200, stream: bodyStream(ndjson) });
    const m = new OllamaChatModel(http, { model: 'm' });
    expect(await streamToString(m.chatStream(req()))).toBe('Hello');
  });

  it('chatStream() emits usage + single canonical message_stop max_tokens for done_reason length (raw length leaked before 1.2b-ii)', async () => {
    const ndjson = JSON.stringify({ message: { content: 'x' } }) + '\n' +
      JSON.stringify({ message: { content: '' }, done: true, done_reason: 'length', prompt_eval_count: 1, eval_count: 2 }) + '\n';
    const { http } = mockHttp({ status: 200, stream: bodyStream(ndjson) });
    const m = new OllamaChatModel(http, { model: 'm' });
    const chunks: StreamChunk[] = [];
    for await (const c of m.chatStream(req())) chunks.push(c);
    expect(chunks).toContainEqual({ kind: 'usage', inputTokens: 1, outputTokens: 2 });
    const stops = chunks.filter((c) => c.kind === 'message_stop');
    expect(stops).toEqual([{ kind: 'message_stop', stopReason: 'max_tokens' }]);
  });

  it('honors custom baseUrl', async () => {
    const { http, calls } = mockHttp({ status: 200, text: '{"message":{"content":""}}' });
    const m = new OllamaChatModel(http, { model: 'm', baseUrl: 'http://ollama.svc:8080' });
    await m.chat(req());
    expect(calls[0]!.url).toBe('http://ollama.svc:8080/api/chat');
  });
});
