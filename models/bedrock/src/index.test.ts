import {
  AnthropicOnBedrockChatModel,
  type BedrockInvoker,
  type BedrockStreamInvoker,
} from './index.js';
import {
  responseText,
  textMessage,
  type ChatRequest,
  type StreamChunk,
} from '@tenet/core';

function mockInvoker(reply: string, capture?: (args: { modelId: string; body: string; signal?: AbortSignal }) => void): BedrockInvoker {
  return {
    async invokeModel(args) {
      capture?.(args);
      return { body: reply };
    },
  };
}

/** Canonical ChatRequest factory — signal is REQUIRED by the contract. */
function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: '',
    messages: [textMessage('user', 'x')],
    maxTokens: 10,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const VALID_RESPONSE = JSON.stringify({
  content: [{ type: 'text', text: 'Hello from Claude' }],
  stop_reason: 'end_turn',
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
  it('formats the request body as Anthropic Messages (block form) on Bedrock', async () => {
    let captured: { modelId: string; body: string } | undefined;
    const invoker = mockInvoker(VALID_RESPONSE, (a) => (captured = a));
    const model = new AnthropicOnBedrockChatModel(invoker, { modelId: 'mid' });
    await model.chat(req({ system: 'SYS', messages: [textMessage('user', 'HI')], maxTokens: 100 }));
    expect(captured?.modelId).toBe('mid');
    const body = JSON.parse(captured!.body) as Record<string, unknown>;
    expect(body.anthropic_version).toBe('2023-06-01');
    expect(body.max_tokens).toBe(100);
    expect(body.system).toBe('SYS');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'HI' }] },
    ]);
    expect(body.tools).toBeUndefined();
  });

  it('forwards AbortSignal through to the invoker', async () => {
    let captured: AbortSignal | undefined;
    const invoker = mockInvoker(VALID_RESPONSE, (a) => (captured = a.signal));
    const model = new AnthropicOnBedrockChatModel(invoker, { modelId: 'mid' });
    const ctrl = new AbortController();
    await model.chat(req({ signal: ctrl.signal }));
    expect(captured).toBe(ctrl.signal);
  });

  it('rejects maxTokens <= 0', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), { modelId: 'm' });
    await expect(model.chat(req({ maxTokens: 0 }))).rejects.toThrow();
  });
});

describe('AnthropicOnBedrockChatModel — response parsing', () => {
  it('extracts text blocks + stopReason from the response envelope', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), { modelId: 'm' });
    const res = await model.chat(req());
    expect(res.content).toEqual([{ type: 'text', text: 'Hello from Claude' }]);
    expect(responseText(res)).toBe('Hello from Claude');
    expect(res.stopReason).toBe('end_turn');
  });

  it('maps stop_reason max_tokens + usage onto ChatResponse (stop_reason was dropped before 1.2b-ii)', async () => {
    const truncated = JSON.stringify({
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    const model = new AnthropicOnBedrockChatModel(mockInvoker(truncated), { modelId: 'm' });
    const res = await model.chat(req());
    expect(res.stopReason).toBe('max_tokens');
    expect(responseText(res)).toBe('truncated');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it('maps stop_reason refusal → refusal (a refused generation must abstain, not ship)', async () => {
    const refused = JSON.stringify({
      content: [{ type: 'text', text: '' }],
      stop_reason: 'refusal',
      usage: { input_tokens: 8, output_tokens: 0 },
    });
    const model = new AnthropicOnBedrockChatModel(mockInvoker(refused), { modelId: 'm' });
    // Dropping the 'refusal' case would default to 'end_turn' — masking a refused generation.
    expect((await model.chat(req())).stopReason).toBe('refusal');
  });

  it('parses tool_use blocks + stopReason tool_use', async () => {
    const toolReply = JSON.stringify({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } }],
      stop_reason: 'tool_use',
    });
    const model = new AnthropicOnBedrockChatModel(mockInvoker(toolReply), { modelId: 'm' });
    const res = await model.chat(req());
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
    ]);
    expect(res.usage).toBeUndefined();
  });

  it('concatenates multiple text blocks', async () => {
    const multi = JSON.stringify({
      content: [
        { type: 'text', text: 'Part 1. ' },
        { type: 'text', text: 'Part 2.' },
      ],
    });
    const model = new AnthropicOnBedrockChatModel(mockInvoker(multi), { modelId: 'm' });
    const res = await model.chat(req());
    expect(responseText(res)).toBe('Part 1. Part 2.');
    expect(res.stopReason).toBe('end_turn'); // absent stop_reason degrades
  });

  it('skips malformed content blocks (tool_use without id)', async () => {
    const mixed = JSON.stringify({
      content: [
        { type: 'tool_use', name: 'someTool', input: {} },
        { type: 'text', text: 'fine' },
      ],
    });
    const model = new AnthropicOnBedrockChatModel(mockInvoker(mixed), { modelId: 'm' });
    const res = await model.chat(req());
    expect(res.content).toEqual([{ type: 'text', text: 'fine' }]);
  });

  it('throws on invalid JSON', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker('not json'), { modelId: 'm' });
    await expect(model.chat(req())).rejects.toThrow(/valid JSON/);
  });

  it('throws when content is missing or not an array', async () => {
    const bad = JSON.stringify({ message: 'unexpected shape' });
    const model = new AnthropicOnBedrockChatModel(mockInvoker(bad), { modelId: 'm' });
    await expect(model.chat(req())).rejects.toThrow(/content.*array/);
  });
});

// ── chatStream ────────────────────────────────────────────────────────

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
    const iter = model.chatStream(req());
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/streamInvoker/);
  });

  it('maps eventstream chunks to StreamChunk text + usage + stop', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), {
      modelId: 'm',
      streamInvoker: streamInvoker(STREAM_EVENTS),
    });
    const chunks: StreamChunk[] = [];
    for await (const c of model.chatStream(req({ system: 's', maxTokens: 100 }))) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
      { kind: 'usage', inputTokens: 12, outputTokens: 5 },
      { kind: 'message_stop', stopReason: 'end_turn' },
    ]);
  });

  it('maps unknown streaming stop_reason to end_turn in exactly one message_stop (raw string leaked before 1.2b-ii)', async () => {
    const events = [
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }),
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'some_future_reason' } }),
      JSON.stringify({ type: 'message_stop' }),
    ];
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), {
      modelId: 'm', streamInvoker: streamInvoker(events),
    });
    const chunks: StreamChunk[] = [];
    for await (const c of model.chatStream(req())) chunks.push(c);
    const stops = chunks.filter((c) => c.kind === 'message_stop');
    expect(stops).toEqual([{ kind: 'message_stop', stopReason: 'end_turn' }]);
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
    const chunks: StreamChunk[] = [];
    for await (const c of model.chatStream(req())) chunks.push(c);
    expect(chunks).toEqual([{ kind: 'text', text: 'bytes ok' }]);
  });

  it('tolerates malformed frames without dying', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), {
      modelId: 'm',
      streamInvoker: streamInvoker(['{{not json', ...STREAM_EVENTS.slice(1, 3)]),
    });
    const chunks: StreamChunk[] = [];
    for await (const c of model.chatStream(req())) chunks.push(c);
    expect(chunks).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
    ]);
  });

  it('rejects maxTokens <= 0', async () => {
    const model = new AnthropicOnBedrockChatModel(mockInvoker(VALID_RESPONSE), {
      modelId: 'm', streamInvoker: streamInvoker([]),
    });
    const iter = model.chatStream(req({ maxTokens: 0 }));
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
      for await (const c of model.chatStream(req({ signal: ctrl.signal }))) {
        if (c.kind === 'text') seen.push(c.text);
      }
    })()).rejects.toThrow(/aborted/);
    expect(seen).toEqual(['first']);
  });
});
