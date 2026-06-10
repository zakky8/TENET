import {
  AgUiRunEmitter,
  AgUiProtocolError,
  encodeSse,
  streamChunksToAgUi,
  type AgUiEvent,
  type StreamChunkLike,
} from './index.js';

function collect(): { events: AgUiEvent[]; sink: (e: AgUiEvent) => void } {
  const events: AgUiEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

const IDS = { threadId: 't1', runId: 'r1' };

describe('AgUiRunEmitter — happy path', () => {
  it('emits a complete text run', () => {
    const { events, sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    const mid = em.startMessage();
    em.content('Hello ');
    em.content('world');
    em.endMessage();
    em.finish({ stopReason: 'end_turn' });

    expect(events.map((e) => e.type)).toEqual([
      'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED',
    ]);
    expect(events[1]).toMatchObject({ messageId: mid, role: 'assistant' });
    expect(events[5]).toMatchObject({ result: { stopReason: 'end_turn' } });
  });

  it('tool call lifecycle with parentMessageId inside an open message', () => {
    const { events, sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    em.startMessage('m1');
    em.startToolCall('tc1', 'search');
    em.toolCallArgs('tc1', '{"q":');
    em.toolCallArgs('tc1', '"weather"}');
    em.endToolCall('tc1');
    em.toolCallResult('tc1', '{"temp":21}');
    em.endMessage();
    em.finish();

    const start = events.find((e) => e.type === 'TOOL_CALL_START');
    expect(start).toMatchObject({ toolCallName: 'search', parentMessageId: 'm1' });
  });

  it('finish() auto-closes open message and tool calls', () => {
    const { events, sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    em.startMessage();
    em.content('partial');
    em.startToolCall('tc1', 'lookup');
    em.finish();
    expect(events.map((e) => e.type)).toEqual([
      'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT',
      'TOOL_CALL_START', 'TEXT_MESSAGE_END', 'TOOL_CALL_END', 'RUN_FINISHED',
    ]);
  });

  it('state + custom events pass through', () => {
    const { events, sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    em.stateSnapshot({ items: [] });
    em.stateDelta([{ op: 'add', path: '/items/-', value: 'x' }]);
    em.custom('tenet.usage', { inputTokens: 10, outputTokens: 5 });
    em.finish();
    expect(events.map((e) => e.type)).toEqual([
      'RUN_STARTED', 'STATE_SNAPSHOT', 'STATE_DELTA', 'CUSTOM', 'RUN_FINISHED',
    ]);
  });
});

describe('AgUiRunEmitter — sequencing guards', () => {
  it('rejects events before RUN_STARTED', () => {
    const { sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    expect(() => em.startMessage()).toThrow(AgUiProtocolError);
  });

  it('rejects double start', () => {
    const { sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    expect(() => em.start()).toThrow(/twice/);
  });

  it('rejects events after finish', () => {
    const { sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    em.finish();
    expect(() => em.startMessage()).toThrow(/after run finished/);
  });

  it('rejects content outside an open message', () => {
    const { sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    expect(() => em.content('orphan')).toThrow(/outside an open message/);
  });

  it('rejects two concurrently open messages', () => {
    const { sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    em.startMessage();
    expect(() => em.startMessage()).toThrow(/already open/);
  });

  it('rejects args/end for unopened tool calls', () => {
    const { sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    expect(() => em.toolCallArgs('nope', '{}')).toThrow(/unopened/);
    expect(() => em.endToolCall('nope')).toThrow(/unopened/);
  });

  it('drops empty content deltas silently', () => {
    const { events, sink } = collect();
    const em = new AgUiRunEmitter(sink, IDS);
    em.start();
    em.startMessage();
    em.content('');
    em.endMessage();
    em.finish();
    expect(events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')).toHaveLength(0);
  });
});

describe('encodeSse', () => {
  it('produces a spec-shaped SSE frame', () => {
    const frame = encodeSse({ type: 'RUN_STARTED', threadId: 't', runId: 'r' });
    expect(frame).toBe('data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n');
  });
});

describe('streamChunksToAgUi — StreamChunk bridge', () => {
  async function* chunks(list: StreamChunkLike[]): AsyncIterable<StreamChunkLike> {
    for (const c of list) yield c;
  }

  async function drain(it: AsyncIterable<AgUiEvent>): Promise<AgUiEvent[]> {
    const out: AgUiEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  it('maps a text+usage+stop stream to a full AG-UI run', async () => {
    const events = await drain(streamChunksToAgUi(chunks([
      { kind: 'text', text: 'The answer ' },
      { kind: 'text', text: 'is 42.' },
      { kind: 'usage', inputTokens: 9, outputTokens: 4 },
      { kind: 'message_stop', stopReason: 'end_turn' },
    ]), IDS));

    expect(events.map((e) => e.type)).toEqual([
      'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT', 'CUSTOM', 'TEXT_MESSAGE_END', 'RUN_FINISHED',
    ]);
    const finished = events.at(-1);
    expect(finished).toMatchObject({ result: { stopReason: 'end_turn' } });
    const usage = events.find((e) => e.type === 'CUSTOM');
    expect(usage).toMatchObject({ name: 'tenet.usage', value: { inputTokens: 9, outputTokens: 4 } });
  });

  it('maps tool_use chunks to TOOL_CALL_* events', async () => {
    const events = await drain(streamChunksToAgUi(chunks([
      { kind: 'tool_use_start', id: 'tc1', name: 'search' },
      { kind: 'tool_use_delta', id: 'tc1', partial: '{"q":"x"}' },
      { kind: 'tool_use_end', id: 'tc1' },
      { kind: 'message_stop', stopReason: 'tool_use' },
    ]), IDS));

    expect(events.map((e) => e.type)).toEqual([
      'RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'RUN_FINISHED',
    ]);
  });

  it('upstream throw → RUN_ERROR, not an unhandled rejection', async () => {
    async function* failing(): AsyncIterable<StreamChunkLike> {
      yield { kind: 'text', text: 'partial' };
      throw new Error('model exploded');
    }
    const events = await drain(streamChunksToAgUi(failing(), IDS));
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', message: 'model exploded' });
  });

  it('empty stream still produces a valid run envelope', async () => {
    const events = await drain(streamChunksToAgUi(chunks([]), IDS));
    expect(events.map((e) => e.type)).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
  });
});

// ── P17 audit G1 regression ───────────────────────────────────────────

describe('streamChunksToAgUi — malformed upstream (audit G1)', () => {
  async function* chunks(list: StreamChunkLike[]): AsyncIterable<StreamChunkLike> {
    for (const c of list) yield c;
  }
  async function drain(it: AsyncIterable<AgUiEvent>): Promise<AgUiEvent[]> {
    const out: AgUiEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  it('stray tool_use_delta without a start is repaired, not an unhandled rejection', async () => {
    const events = await drain(streamChunksToAgUi(chunks([
      { kind: 'tool_use_delta', id: 'tc1', partial: '{"q":1}' },
      { kind: 'tool_use_end', id: 'tc1' },
      { kind: 'message_stop', stopReason: 'tool_use' },
    ]), IDS));
    const types = events.map((e) => e.type);
    expect(types).toContain('TOOL_CALL_START'); // synthesized
    expect(types).toContain('TOOL_CALL_END');
    expect(types.at(-1)).toBe('RUN_FINISHED'); // no throw, clean finish
  });

  it('duplicate tool_use_start is de-duplicated', async () => {
    const events = await drain(streamChunksToAgUi(chunks([
      { kind: 'tool_use_start', id: 'tc1', name: 'search' },
      { kind: 'tool_use_start', id: 'tc1', name: 'search' },
      { kind: 'tool_use_end', id: 'tc1' },
      { kind: 'message_stop', stopReason: 'tool_use' },
    ]), IDS));
    expect(events.filter((e) => e.type === 'TOOL_CALL_START')).toHaveLength(1);
    expect(events.at(-1)!.type).toBe('RUN_FINISHED');
  });
});
