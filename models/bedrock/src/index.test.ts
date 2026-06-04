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
