import { OllamaChatModel, OllamaApiError, type OllamaHttp } from './index.js';
import { streamToString } from '@tenet/streaming';

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

describe('OllamaChatModel', () => {
  it('rejects missing model + bad temperature', () => {
    const { http } = mockHttp({ status: 200 });
    expect(() => new OllamaChatModel(http, { model: '' })).toThrow();
    expect(() => new OllamaChatModel(http, { model: 'm', temperature: -1 })).toThrow();
  });

  it('chat() returns content + targets localhost:11434 default', async () => {
    const { http, calls } = mockHttp({
      status: 200,
      text: JSON.stringify({ message: { content: 'hello' } }),
    });
    const m = new OllamaChatModel(http, { model: 'llama3.3' });
    expect(await m.chat({ system: 's', user: 'u', maxTokens: 10 })).toBe('hello');
    expect(calls[0]!.url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(calls[0]!.body);
    expect(body.model).toBe('llama3.3');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(10);
  });

  it('chat() throws OllamaApiError on non-2xx', async () => {
    const { http } = mockHttp({ status: 503, text: 'down' });
    const m = new OllamaChatModel(http, { model: 'm' });
    await expect(m.chat({ system: 's', user: 'u', maxTokens: 1 })).rejects.toBeInstanceOf(OllamaApiError);
  });

  it('chatStream() parses NDJSON + emits text + done', async () => {
    const ndjson =
      JSON.stringify({ message: { content: 'Hel' } }) + '\n' +
      JSON.stringify({ message: { content: 'lo' } }) + '\n' +
      JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }) + '\n';
    const { http } = mockHttp({ status: 200, stream: bodyStream(ndjson) });
    const m = new OllamaChatModel(http, { model: 'm' });
    expect(await streamToString(m.chatStream({ system: 's', user: 'u', maxTokens: 1 }))).toBe('Hello');
  });

  it('chatStream() emits usage + message_stop on done', async () => {
    const ndjson = JSON.stringify({ message: { content: 'x' } }) + '\n' +
      JSON.stringify({ message: { content: '' }, done: true, done_reason: 'length', prompt_eval_count: 1, eval_count: 2 }) + '\n';
    const { http } = mockHttp({ status: 200, stream: bodyStream(ndjson) });
    const m = new OllamaChatModel(http, { model: 'm' });
    const chunks = [];
    for await (const c of m.chatStream({ system: 's', user: 'u', maxTokens: 1 })) chunks.push(c);
    expect(chunks.some((c) => c.kind === 'usage')).toBe(true);
    expect(chunks.some((c) => c.kind === 'message_stop' && c.stopReason === 'length')).toBe(true);
  });

  it('honors custom baseUrl', async () => {
    const { http, calls } = mockHttp({ status: 200, text: '{"message":{"content":""}}' });
    const m = new OllamaChatModel(http, { model: 'm', baseUrl: 'http://ollama.svc:8080' });
    await m.chat({ system: 's', user: 'u', maxTokens: 1 });
    expect(calls[0]!.url).toBe('http://ollama.svc:8080/api/chat');
  });
});
