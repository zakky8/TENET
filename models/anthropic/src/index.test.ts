import {
  AnthropicChatModel,
  AnthropicApiError,
  type AnthropicHttp,
} from './index.js';

function mockHttp(reply: { status: number; body: string }, capture?: (req: { url: string; init: { method: string; headers: Record<string, string>; body: string } }) => void): AnthropicHttp {
  return {
    async fetch(url, init) {
      capture?.({ url, init });
      return {
        status: reply.status,
        async text() {
          return reply.body;
        },
      };
    },
  };
}

const VALID_BODY = JSON.stringify({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello from Claude' }],
});

describe('AnthropicChatModel — construction', () => {
  it('requires apiKey + model', () => {
    expect(() => new AnthropicChatModel(mockHttp({ status: 200, body: '{}' }), { apiKey: '', model: 'm' })).toThrow();
    expect(() => new AnthropicChatModel(mockHttp({ status: 200, body: '{}' }), { apiKey: 'k', model: '' })).toThrow();
  });
  it('rejects out-of-range temperature', () => {
    const h = mockHttp({ status: 200, body: '{}' });
    expect(() => new AnthropicChatModel(h, { apiKey: 'k', model: 'm', temperature: 1.5 })).toThrow();
  });
});

describe('AnthropicChatModel — request shape', () => {
  it('POSTs to /v1/messages with the correct headers + body', async () => {
    let captured: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | undefined;
    const m = new AnthropicChatModel(
      mockHttp({ status: 200, body: VALID_BODY }, (r) => (captured = r)),
      { apiKey: 'sk-test', model: 'claude-opus-4-8-20260528' },
    );
    await m.chat({ system: 'SYS', user: 'HI', maxTokens: 100 });
    expect(captured?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured?.init.method).toBe('POST');
    expect(captured?.init.headers['x-api-key']).toBe('sk-test');
    expect(captured?.init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(captured!.init.body) as Record<string, unknown>;
    expect(body.model).toBe('claude-opus-4-8-20260528');
    expect(body.max_tokens).toBe(100);
    expect(body.system).toBe('SYS');
    expect(body.messages).toEqual([{ role: 'user', content: 'HI' }]);
  });

  it('honors custom baseUrl + strips trailing slash', async () => {
    let captured: { url: string } | undefined;
    const m = new AnthropicChatModel(
      mockHttp({ status: 200, body: VALID_BODY }, (r) => (captured = r)),
      { apiKey: 'k', model: 'm', baseUrl: 'https://gateway.example.com/' },
    );
    await m.chat({ system: '', user: 'x', maxTokens: 10 });
    expect(captured!.url).toBe('https://gateway.example.com/v1/messages');
  });

  it('sets anthropic-beta header when betas provided', async () => {
    let captured: { init: { headers: Record<string, string> } } | undefined;
    const m = new AnthropicChatModel(
      mockHttp({ status: 200, body: VALID_BODY }, (r) => (captured = r)),
      { apiKey: 'k', model: 'm', betas: ['prompt-caching-2024-07-31'] },
    );
    await m.chat({ system: '', user: 'x', maxTokens: 10 });
    expect(captured!.init.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });

  it('rejects maxTokens <= 0', async () => {
    const m = new AnthropicChatModel(mockHttp({ status: 200, body: VALID_BODY }), {
      apiKey: 'k',
      model: 'm',
    });
    await expect(m.chat({ system: '', user: '', maxTokens: 0 })).rejects.toThrow();
  });
});

describe('AnthropicChatModel — response handling', () => {
  it('extracts text from content blocks', async () => {
    const m = new AnthropicChatModel(mockHttp({ status: 200, body: VALID_BODY }), {
      apiKey: 'k',
      model: 'm',
    });
    expect(await m.chat({ system: '', user: '', maxTokens: 10 })).toBe('Hello from Claude');
  });

  it('throws AnthropicApiError for non-2xx', async () => {
    const m = new AnthropicChatModel(
      mockHttp({ status: 429, body: '{"type":"error","error":{"type":"rate_limit_error"}}' }),
      { apiKey: 'k', model: 'm' },
    );
    await expect(m.chat({ system: '', user: '', maxTokens: 10 })).rejects.toBeInstanceOf(AnthropicApiError);
  });

  it('throws on invalid JSON response', async () => {
    const m = new AnthropicChatModel(mockHttp({ status: 200, body: 'not json' }), {
      apiKey: 'k',
      model: 'm',
    });
    await expect(m.chat({ system: '', user: '', maxTokens: 10 })).rejects.toThrow(/valid JSON/);
  });

  it('throws on missing content array', async () => {
    const m = new AnthropicChatModel(mockHttp({ status: 200, body: '{"message":"oops"}' }), {
      apiKey: 'k',
      model: 'm',
    });
    await expect(m.chat({ system: '', user: '', maxTokens: 10 })).rejects.toThrow(/content/);
  });
});
