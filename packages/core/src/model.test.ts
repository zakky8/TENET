import { jest } from '@jest/globals';
import {
  textMessage,
  responseText,
  toolUses,
  fromLegacyModel,
  asLegacyModel,
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  type LegacySingleStringModel,
  type LegacyChatArgs,
} from './model.js';

describe('textMessage', () => {
  it('wraps role + text into a single text content block', () => {
    expect(textMessage('user', 'hello')).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('preserves the role verbatim (assistant/system/tool), not just user', () => {
    expect(textMessage('assistant', 'hi')).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(textMessage('system', 'sys')).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'sys' }],
    });
  });
});

describe('responseText', () => {
  it('concatenates only text blocks, ignoring tool_use and tool_result blocks', () => {
    const res: ChatResponse = {
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'x' } },
        { type: 'tool_result', toolUseId: 't1', content: 'IGNORED RESULT' },
        { type: 'text', text: 'world' },
      ],
      stopReason: 'end_turn',
    };
    // If tool_use/tool_result leaked in, this would fail (extra text or thrown error).
    expect(responseText(res)).toBe('Hello world');
  });

  it('returns empty string when there are no text blocks', () => {
    const res: ChatResponse = {
      content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }],
      stopReason: 'tool_use',
    };
    expect(responseText(res)).toBe('');
  });
});

describe('toolUses', () => {
  it('returns only tool_use blocks, filtering out text and tool_result', () => {
    const res: ChatResponse = {
      content: [
        { type: 'text', text: 'thinking...' },
        { type: 'tool_use', id: 'a', name: 'search', input: { q: '1' } },
        { type: 'tool_result', toolUseId: 'a', content: 'result data' },
        { type: 'tool_use', id: 'b', name: 'fetch', input: { url: 'x' } },
      ],
      stopReason: 'tool_use',
    };
    const calls = toolUses(res);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(calls.every((c) => c.type === 'tool_use')).toBe(true);
  });

  it('returns an empty array when the response has no tool_use blocks', () => {
    const res: ChatResponse = {
      content: [{ type: 'text', text: 'no tools here' }],
      stopReason: 'end_turn',
    };
    expect(toolUses(res)).toEqual([]);
  });
});

describe('fromLegacyModel', () => {
  it('adapts a legacy single-string model so chat() returns a canonical text response with end_turn', async () => {
    const legacy: LegacySingleStringModel = {
      chat: jest.fn(async (_args: LegacyChatArgs) => 'legacy reply text'),
    };
    const model: ChatModel = fromLegacyModel(legacy);

    const req: ChatRequest = {
      system: 'sys prompt',
      messages: [textMessage('user', 'hi there')],
      maxTokens: 100,
      signal: new AbortController().signal,
    };
    const res = await model.chat(req);

    expect(res).toEqual({
      content: [{ type: 'text', text: 'legacy reply text' }],
      stopReason: 'end_turn',
    });
  });

  it('flattens messages into ONE boundary user string: text + tool_result content, in message order', async () => {
    let capturedArgs: LegacyChatArgs | undefined;
    const legacy: LegacySingleStringModel = {
      chat: async (args) => {
        capturedArgs = args;
        return 'ok';
      },
    };
    const model = fromLegacyModel(legacy);

    const req: ChatRequest = {
      system: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_result', toolUseId: 'x', content: 'tool output' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
      ],
      maxTokens: 50,
      signal: new AbortController().signal,
    };
    await model.chat(req);

    // Exactly one flatten: text + tool_result content joined with '\n', in message order.
    // If flattening happened twice (or not at all), this exact string would not match.
    expect(capturedArgs?.user).toBe('first\ntool output\nsecond');
    expect(capturedArgs?.system).toBe('sys');
    expect(capturedArgs?.maxTokens).toBe(50);
  });

  it('drops tool_use blocks from the flattened text (they contribute nothing, not "[object Object]")', async () => {
    let capturedArgs: LegacyChatArgs | undefined;
    const legacy: LegacySingleStringModel = {
      chat: async (args) => {
        capturedArgs = args;
        return 'ok';
      },
    };
    const model = fromLegacyModel(legacy);

    const req: ChatRequest = {
      system: 'sys',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'before' },
            { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
            { type: 'text', text: 'after' },
          ],
        },
      ],
      maxTokens: 10,
      signal: new AbortController().signal,
    };
    await model.chat(req);

    expect(capturedArgs?.user).toBe('before\n\nafter');
  });
});

describe('asLegacyModel', () => {
  it('adapts a canonical model so legacy chat({system,user,maxTokens}) returns the concatenated response text', async () => {
    const canonical: ChatModel = {
      chat: jest.fn(async (req: ChatRequest): Promise<ChatResponse> => {
        const firstBlock = req.messages[0]?.content[0];
        const userText = firstBlock?.type === 'text' ? firstBlock.text : '';
        return {
          content: [
            { type: 'text', text: `reply to: ${req.system}/${userText}` },
            { type: 'tool_use', id: 'z', name: 'noop', input: {} },
          ],
          stopReason: 'tool_use',
        };
      }),
    };
    const legacy = asLegacyModel(canonical);

    const text = await legacy.chat({ system: 'SYS', user: 'USER MSG', maxTokens: 200 });

    // Only the text block should surface — tool_use is dropped by responseText.
    expect(text).toBe('reply to: SYS/USER MSG');
  });

  it('when the legacy caller omits a signal, synthesizes one to satisfy the required-signal contract — legacy parity, intentionally un-abortable', async () => {
    let receivedSignal: AbortSignal | undefined;
    const canonical: ChatModel = {
      chat: async (req: ChatRequest) => {
        receivedSignal = req.signal;
        return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' };
      },
    };
    const legacy = asLegacyModel(canonical);

    // No signal passed — must not throw, and must forward a real, non-aborted AbortSignal
    // so the canonical REQUIRED-signal contract is satisfied.
    await expect(
      legacy.chat({ system: 's', user: 'u', maxTokens: 10 }),
    ).resolves.toBe('ok');
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
    // HONEST DOCUMENTATION of the known limitation (not a blessed guarantee): this
    // synthesized signal comes from a discarded controller, so it can NEVER transition
    // to aborted — legacy callers never had cancellation. The abortable path is covered
    // by the next test (an explicitly-provided signal is forwarded verbatim).
  });

  it('forwards an explicitly-provided signal instead of manufacturing a new one', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const canonical: ChatModel = {
      chat: async (req: ChatRequest) => {
        receivedSignal = req.signal;
        return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' };
      },
    };
    const legacy = asLegacyModel(canonical);

    await legacy.chat({ system: 's', user: 'u', maxTokens: 10, signal: controller.signal });

    expect(receivedSignal).toBe(controller.signal);
  });
});
