import {
  AcpAgent,
  createNdjsonParser,
  isRequest,
  ndjsonSink,
  ACP_METHODS,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  type AcpHandler,
  type AcpOutboundSink,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonRpcNotification,
} from './index.js';

function capturingSink(): { sink: AcpOutboundSink; sent: JsonRpcMessage[] } {
  const sent: JsonRpcMessage[] = [];
  return {
    sink: { send: (msg) => sent.push(msg) },
    sent,
  };
}

function makeAgent(handler: AcpHandler, sink: AcpOutboundSink): AcpAgent {
  return new AcpAgent({
    info: { name: 'tenet', title: 'TENET', version: '0.0.0' },
    capabilities: { prompt: { text: true, resource: true }, sessions: true },
    handler,
    now: () => 1_700_000_000_000,
  }, sink);
}

const NOOP_HANDLER: AcpHandler = {
  async handlePrompt() { return { stopReason: 'end_turn' }; },
};

describe('AcpAgent — initialize', () => {
  it('responds with negotiated version + agentCapabilities + agentInfo', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({
      jsonrpc: '2.0',
      id: 0,
      method: ACP_METHODS.initialize,
      params: {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true } },
        clientInfo: { name: 'zed', version: '1.0.0' },
      },
    });
    expect(sent).toHaveLength(1);
    const r = sent[0] as JsonRpcSuccess<{ protocolVersion: number; agentInfo: { name: string }; agentCapabilities: { prompt?: { text?: boolean } } }>;
    expect(r.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(r.result.agentInfo.name).toBe('tenet');
    expect(r.result.agentCapabilities.prompt?.text).toBe(true);
  });

  it('downgrades to our supported version when client asks for higher', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({
      jsonrpc: '2.0',
      id: 0,
      method: ACP_METHODS.initialize,
      params: {
        protocolVersion: 99,
        clientCapabilities: {},
        clientInfo: { name: 'c', version: '1' },
      },
    });
    const r = sent[0] as JsonRpcSuccess<{ protocolVersion: number }>;
    expect(r.result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('rejects malformed params with INVALID_PARAMS', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({
      jsonrpc: '2.0',
      id: 0,
      method: ACP_METHODS.initialize,
      params: { /* missing protocolVersion */ } as any,
    });
    expect((sent[0] as JsonRpcError).error.code).toBe(INVALID_PARAMS);
  });
});

describe('AcpAgent — session lifecycle', () => {
  it('session/new requires prior initialize', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 1, method: ACP_METHODS.sessionNew });
    expect((sent[0] as JsonRpcError).error.code).toBe(INVALID_PARAMS);
  });

  it('initialize then session/new returns a sessionId', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({
      jsonrpc: '2.0', id: 0, method: ACP_METHODS.initialize,
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } },
    });
    sent.length = 0;
    await agent.dispatch({ jsonrpc: '2.0', id: 1, method: ACP_METHODS.sessionNew });
    const r = sent[0] as JsonRpcSuccess<{ sessionId: string }>;
    expect(typeof r.result.sessionId).toBe('string');
    expect(r.result.sessionId).toMatch(/^sess_/);
  });

  it('session/prompt runs the handler and emits final result', async () => {
    const { sink, sent } = capturingSink();
    const echo: AcpHandler = {
      async handlePrompt(prompt, ctx) {
        ctx.emit({ type: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
        return { stopReason: 'end_turn' };
      },
    };
    const agent = makeAgent(echo, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 0, method: ACP_METHODS.initialize, params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    await agent.dispatch({ jsonrpc: '2.0', id: 1, method: ACP_METHODS.sessionNew });
    const sid = (sent[1] as JsonRpcSuccess<{ sessionId: string }>).result.sessionId;
    sent.length = 0;
    await agent.dispatch({
      jsonrpc: '2.0', id: 2, method: ACP_METHODS.sessionPrompt,
      params: { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] },
    });
    // First: the session/update notification
    expect(sent[0]).toMatchObject({ jsonrpc: '2.0', method: ACP_METHODS.sessionUpdate });
    const notif = sent[0] as JsonRpcNotification<{ sessionId: string; update: { type: string } }>;
    expect(notif.params!.sessionId).toBe(sid);
    expect(notif.params!.update.type).toBe('agent_message_chunk');
    // Then: the final response
    expect(sent[1]).toMatchObject({ id: 2, result: { stopReason: 'end_turn' } });
  });

  it('session/cancel aborts in-flight prompt + returns user_cancel', async () => {
    const { sink, sent } = capturingSink();
    const slow: AcpHandler = {
      async handlePrompt(_, ctx) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 50);
          ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
        });
        return { stopReason: 'end_turn' };
      },
    };
    const agent = makeAgent(slow, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 0, method: ACP_METHODS.initialize, params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    await agent.dispatch({ jsonrpc: '2.0', id: 1, method: ACP_METHODS.sessionNew });
    const sid = (sent[1] as JsonRpcSuccess<{ sessionId: string }>).result.sessionId;
    sent.length = 0;
    const promptPromise = agent.dispatch({
      jsonrpc: '2.0', id: 2, method: ACP_METHODS.sessionPrompt,
      params: { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] },
    });
    await agent.dispatch({ jsonrpc: '2.0', id: 3, method: ACP_METHODS.sessionCancel, params: { sessionId: sid } });
    await promptPromise;
    const final = sent.find((m) => (m as JsonRpcSuccess).id === 2) as JsonRpcSuccess<{ stopReason: string }> | undefined;
    expect(final?.result.stopReason).toBe('user_cancel');
  });

  it('unknown method → METHOD_NOT_FOUND', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 9, method: 'totally/unknown' });
    expect((sent[0] as JsonRpcError).error.code).toBe(METHOD_NOT_FOUND);
  });

  it('session/prompt with unknown sessionId → INVALID_PARAMS', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 0, method: ACP_METHODS.initialize, params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    sent.length = 0;
    await agent.dispatch({
      jsonrpc: '2.0', id: 5, method: ACP_METHODS.sessionPrompt,
      params: { sessionId: 'ghost', prompt: [] },
    });
    expect((sent[0] as JsonRpcError).error.code).toBe(INVALID_PARAMS);
  });

  it('returns INTERNAL_ERROR when handler throws (not cancel)', async () => {
    const { sink, sent } = capturingSink();
    const boom: AcpHandler = { async handlePrompt() { throw new Error('boom'); } };
    const agent = makeAgent(boom, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 0, method: ACP_METHODS.initialize, params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    await agent.dispatch({ jsonrpc: '2.0', id: 1, method: ACP_METHODS.sessionNew });
    const sid = (sent[1] as JsonRpcSuccess<{ sessionId: string }>).result.sessionId;
    sent.length = 0;
    await agent.dispatch({
      jsonrpc: '2.0', id: 2, method: ACP_METHODS.sessionPrompt,
      params: { sessionId: sid, prompt: [] },
    });
    expect((sent[0] as JsonRpcError).error.message).toMatch(/boom/);
  });
});

describe('stdio — NDJSON parser', () => {
  it('parses a single line', () => {
    const p = createNdjsonParser();
    const msgs = p.feed('{"jsonrpc":"2.0","id":0,"method":"x"}\n');
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as JsonRpcRequest).method).toBe('x');
  });

  it('handles split chunks', () => {
    const p = createNdjsonParser();
    expect(p.feed('{"jsonrpc":"2.0","id":')).toEqual([]);
    const msgs = p.feed('0,"method":"x"}\n');
    expect(msgs).toHaveLength(1);
  });

  it('parses multiple lines in one chunk', () => {
    const p = createNdjsonParser();
    const msgs = p.feed('{"jsonrpc":"2.0","id":0,"method":"a"}\n{"jsonrpc":"2.0","id":1,"method":"b"}\n');
    expect(msgs.map((m) => (m as JsonRpcRequest).method)).toEqual(['a', 'b']);
  });

  it('handles CRLF line endings', () => {
    const p = createNdjsonParser();
    const msgs = p.feed('{"jsonrpc":"2.0","id":0,"method":"x"}\r\n');
    expect(msgs).toHaveLength(1);
  });

  it('skips unparseable lines silently', () => {
    const p = createNdjsonParser();
    const msgs = p.feed('garbage\n{"jsonrpc":"2.0","id":0,"method":"ok"}\n');
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as JsonRpcRequest).method).toBe('ok');
  });

  it('throws on unbounded line growth (DoS guard)', () => {
    const p = createNdjsonParser();
    expect(() => p.feed('x'.repeat(5 * 1024 * 1024))).toThrow(/exceeded/);
  });

  it('finish() flushes the final partial line', () => {
    const p = createNdjsonParser();
    p.feed('{"jsonrpc":"2.0","id":0,"method":"x"}');
    expect(p.finish()).toHaveLength(1);
  });
});

describe('stdio — outbound sink', () => {
  it('writes NDJSON frames', () => {
    const writes: string[] = [];
    const sink = ndjsonSink((s) => writes.push(s));
    sink.send({ jsonrpc: '2.0', id: 0, result: 'ok' });
    expect(writes[0]).toBe('{"jsonrpc":"2.0","id":0,"result":"ok"}\n');
  });
});

describe('isRequest predicate', () => {
  it('is true for {id, method}', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 0, method: 'x' })).toBe(true);
  });
  it('is false for a notification (no id)', () => {
    expect(isRequest({ jsonrpc: '2.0', method: 'x' } as JsonRpcMessage)).toBe(false);
  });
  // CORRECTNESS 2026-06-04 vuln-test #B6
  it('is false for id:null (JSON-RPC error responses + tolerant notifications)', () => {
    expect(isRequest({ jsonrpc: '2.0', id: null, method: 'x' } as unknown as JsonRpcMessage)).toBe(false);
  });
});

describe('vuln-test follow-ups (P14)', () => {
  // SECURITY 2026-06-04 vuln-test #A5: random session ids
  it('mints cryptographically-random 32-hex sessionIds (not predictable)', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 0, method: ACP_METHODS.initialize, params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    sent.length = 0;
    await agent.dispatch({ jsonrpc: '2.0', id: 1, method: ACP_METHODS.sessionNew });
    await agent.dispatch({ jsonrpc: '2.0', id: 2, method: ACP_METHODS.sessionNew });
    const id1 = (sent[0] as JsonRpcSuccess<{ sessionId: string }>).result.sessionId;
    const id2 = (sent[1] as JsonRpcSuccess<{ sessionId: string }>).result.sessionId;
    expect(id1).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(id2).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(id1).not.toBe(id2);
  });

  // CORRECTNESS 2026-06-04 vuln-test #B1
  it('subsequent prompt after cancel uses a fresh AbortController (no sticky abort)', async () => {
    const { sink, sent } = capturingSink();
    let abortedFirst = false;
    let abortedSecond: boolean | null = null;
    const handler: AcpHandler = {
      async handlePrompt(_, ctx) {
        if (!abortedFirst) {
          abortedFirst = true;
          // Yield until signal aborts to simulate a long turn cancelled by client.
          await new Promise((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
            setTimeout(resolve, 100);
          });
        } else {
          abortedSecond = ctx.signal.aborted; // should be false now
        }
        return { stopReason: 'end_turn' };
      },
    };
    const agent = makeAgent(handler, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 0, method: ACP_METHODS.initialize, params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    await agent.dispatch({ jsonrpc: '2.0', id: 1, method: ACP_METHODS.sessionNew });
    const sid = (sent[1] as JsonRpcSuccess<{ sessionId: string }>).result.sessionId;
    const p1 = agent.dispatch({ jsonrpc: '2.0', id: 2, method: ACP_METHODS.sessionPrompt, params: { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] } });
    await agent.dispatch({ jsonrpc: '2.0', id: 3, method: ACP_METHODS.sessionCancel, params: { sessionId: sid } });
    await p1;
    // Second prompt — the fix means signal is FRESH (not pre-aborted).
    await agent.dispatch({ jsonrpc: '2.0', id: 4, method: ACP_METHODS.sessionPrompt, params: { sessionId: sid, prompt: [{ type: 'text', text: 'hi-again' }] } });
    expect(abortedSecond).toBe(false);
  });

  // SECURITY 2026-06-04 vuln-test #B2
  it('rejects protocolVersion 0 / negative / non-integer', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 0, method: ACP_METHODS.initialize, params: { protocolVersion: 0, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    expect((sent[0] as JsonRpcError).error.code).toBe(INVALID_PARAMS);
    sent.length = 0;
    await agent.dispatch({ jsonrpc: '2.0', id: 1, method: ACP_METHODS.initialize, params: { protocolVersion: -1, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    expect((sent[0] as JsonRpcError).error.code).toBe(INVALID_PARAMS);
    sent.length = 0;
    await agent.dispatch({ jsonrpc: '2.0', id: 2, method: ACP_METHODS.initialize, params: { protocolVersion: 1.5 as any, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    expect((sent[0] as JsonRpcError).error.code).toBe(INVALID_PARAMS);
  });

  // CORRECTNESS 2026-06-04 vuln-test #B3
  it('session/cancel without id (notification form) emits no response', async () => {
    const { sink, sent } = capturingSink();
    const agent = makeAgent(NOOP_HANDLER, sink);
    await agent.dispatch({ jsonrpc: '2.0', id: 0, method: ACP_METHODS.initialize, params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    await agent.dispatch({ jsonrpc: '2.0', id: 1, method: ACP_METHODS.sessionNew });
    const sid = (sent[1] as JsonRpcSuccess<{ sessionId: string }>).result.sessionId;
    sent.length = 0;
    // No id → notification form. Should silently cancel.
    await agent.dispatch({ jsonrpc: '2.0', method: ACP_METHODS.sessionCancel, params: { sessionId: sid } } as any);
    expect(sent).toEqual([]);
  });
});
