import { textMessage, responseText, toolUses, type ChatResponse } from './model.js';

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
