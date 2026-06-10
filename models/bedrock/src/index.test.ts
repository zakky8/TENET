import { AnthropicOnBedrockChatModel, type BedrockInvoker } from './index.js';

function mockInvoker(reply: string, capture?: (args: { modelId: string; body: string; signal?: AbortSignal }) => void): BedrockInvoker {
  return {
    async invokeModel(args) {
      capture?.(args);
      return { body: reply };
    },
  };
}

const VALID_RESPONSE = JSON.stringify({
  content: [{ type: 'text', text: 'Hello from Claude' }],
});

describe('AnthropicOnBedrockChatModel — construction', () => {
  it('requires modelId', () => {
    expect(
      () => new AnthropicOnBedrockChatModel(mockInvoker(''), { modelId: '' }),
    ).toThrow();
  });

  it('rejects temperature out of range', () => {
    const invoker = mockInvoker('');
    expect(
      () => new AnthropicOnBedrockChatModel(invoker, { modelId: 'm', temperature: -0.1 }),
    ).toThrow();
    expect(
      () => new AnthropicOnBedrockChatModel(invoker, { modelId: 'm', temperature: 1.1 }),
    ).toThrow();
  });

  it('accepts defaults', () => {
    expect(
      () => new AnthropicOnBedrockChatModel(mockInvoker(''), { modelId: 'm' }),
    ).not.toThrow();
  });
});

describe('AnthropicOnBedrockChatModel — chat()', () => {
  it('formats the request body as Anthropic Messages on Bedrock', async () => {
    let captured: { modelId: string; body: string } | undefined;
    const invoker = mockInvoker(VALID_RESPONSE, (a) => (captured = a));
    const model = new AnthropicOnBedrockChatModel(invoker, { modelId: 'mid' });
    await model.chat({ system: 'SYS', user: 'HI', maxTokens: 100 });
    expect(captured?.modelId).toBe('mid');
    const body = JSON.parse(captured!.body) as Record<string, unknown>;
    expect(body.anthropic_version).toBe('2023-06-01');
    expect(body.max_tokens).toBe(100);
    expect(body.system).toBe('SYS');
    expect(body.messages).toEqual([{ role: 'user', content: 'HI' }]);
  });

  it('forwards AbortSignal through to the invoker', async () => {
    let captured: AbortSignal | undefined;
    const invoker = mockInvoker(VALID_RESPONSE, (a) => (captured = a.signal));
    const model = new AnthropicOnBedrockChatModel(invoker, { modelId: 'mid' });
    const ctrl = new AbortController();
    await model.chat({ system: 'x', user: 'y', maxTokens: 10, signal: ctrl.signal });
    expect(captured).toBe(ctrl.signal);
  });

  it('rejects maxTokens <= 0', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), { modelId: 'm' });
    await expect(model.chat({ system: '', user: '', maxTokens: 0 })).rejects.toThrow();
  });
});

describe('AnthropicOnBedrockChatModel — response parsing', () => {
  it('extracts text from the content array', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), { modelId: 'm' });
    expect(await model.chat({ system: '', user: '', maxTokens: 10 })).toBe('Hello from Claude');
  });

  it('concatenates multiple text blocks', async () => {
    const multi = JSON.stringify({
      content: [
        { type: 'text', text: 'Part 1. ' },
        { type: 'text', text: 'Part 2.' },
      ],
    });
    const model = new AnthropicOnBedrockChatModel(mockInvoker(multi), { modelId: 'm' });
    expect(await model.chat({ system: '', user: '', maxTokens: 10 })).toBe('Part 1. Part 2.');
  });

  it('ignores non-text content blocks', async () => {
    const mixed = JSON.stringify({
      content: [
        { type: 'tool_use', name: 'someTool', input: {} },
        { type: 'text', text: 'fine' },
      ],
    });
    const model = new AnthropicOnBedrockChatModel(mockInvoker(mixed), { modelId: 'm' });
    expect(await model.chat({ system: '', user: '', maxTokens: 10 })).toBe('fine');
  });

  it('throws on invalid JSON', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker('not json'), { modelId: 'm' });
    await expect(model.chat({ system: '', user: '', maxTokens: 10 })).rejects.toThrow(
      /valid JSON/,
    );
  });

  it('throws when content is missing or not an array', async () => {
    const bad = JSON.stringify({ message: 'unexpected shape' });
    const model = new AnthropicOnBedrockChatModel(mockInvoker(bad), { modelId: 'm' });
    await expect(model.chat({ system: '', user: '', maxTokens: 10 })).rejects.toThrow(
      /content.*array/,
    );
  });
});

// ── chatStream (P15.1 — closing the falsely-claimed P8 gap) ───────────

import type { BedrockStreamInvoker } from './index.js';

function streamInvoker(events: string[]): BedrockStreamInvoker {
  return {
    async *invokeModelWithResponseStream() {
      for (const e of events) yield e;
    },
  };
}

const STREAM_EVENTS = [
  JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 12 } } }),
  JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } }),
  JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } }),
  JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
  JSON.stringify({ type: 'message_stop' }),
];

describe('AnthropicOnBedrockChatModel — chatStream', () => {
  it('throws a wiring hint when no streamInvoker provided', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), { modelId: 'm' });
    const iter = model.chatStream({ system: '', user: 'q', maxTokens: 10 });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/streamInvoker/);
  });

  it('maps eventstream chunks to StreamChunk text + usage + stop', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), {
      modelId: 'm',
      streamInvoker: streamInvoker(STREAM_EVENTS),
    });
    const chunks = [];
    for await (const c of model.chatStream({ system: 's', user: 'q', maxTokens: 100 })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
      { kind: 'usage', inputTokens: 12, outputTokens: 5 },
      { kind: 'message_stop', stopReason: 'end_turn' },
    ]);
  });

  it('accepts Uint8Array frames (raw chunk.bytes)', async () => {
    const enc = new TextEncoder();
    const inv: BedrockStreamInvoker = {
      async *invokeModelWithResponseStream() {
        yield enc.encode(JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'bytes ok' } }));
      },
    };
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), {
      modelId: 'm', streamInvoker: inv,
    });
    const chunks = [];
    for await (const c of model.chatStream({ system: '', user: 'q', maxTokens: 10 })) chunks.push(c);
    expect(chunks).toEqual([{ kind: 'text', text: 'bytes ok' }]);
  });

  it('tolerates malformed frames without dying', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), {
      modelId: 'm',
      streamInvoker: streamInvoker(['{{not json', ...STREAM_EVENTS.slice(1, 3)]),
    });
    const chunks = [];
    for await (const c of model.chatStream({ system: '', user: 'q', maxTokens: 10 })) chunks.push(c);
    expect(chunks).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
    ]);
  });

  it('rejects maxTokens <= 0', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), {
      modelId: 'm', streamInvoker: streamInvoker([]),
    });
    const iter = model.chatStream({ system: '', user: 'q', maxTokens: 0 });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/maxTokens/);
  });

  it('aborts mid-stream on signal', async () => {
    const ctrl = new AbortController();
    const inv: BedrockStreamInvoker = {
      async *invokeModelWithResponseStream() {
        yield JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } });
        ctrl.abort();
        yield JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'second' } });
      },
    };
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), {
      modelId: 'm', streamInvoker: inv,
    });
    const seen: string[] = [];
    await expect((async () => {
      for await (const c of model.chatStream({ system: '', user: 'q', maxTokens: 10, signal: ctrl.signal })) {
        if (c.kind === 'text') seen.push(c.text);
      }
    })()).rejects.toThrow(/aborted/);
    expect(seen).toEqual(['first']);
  });
});
