import {
  MCPClient,
  MCPError,
  MCPToolRegistry,
  type MCPTransport,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './index.js';

function mockTransport(handler: (req: JsonRpcRequest) => unknown | { error: { code: number; message: string } }): MCPTransport {
  return {
    async call(req): Promise<JsonRpcResponse> {
      const out = handler(req);
      if (out !== null && typeof out === 'object' && 'error' in out) {
        return { jsonrpc: '2.0', id: req.id, error: (out as { error: { code: number; message: string } }).error };
      }
      return { jsonrpc: '2.0', id: req.id, result: out };
    },
    async close() {},
  };
}

const TOOLS_LIST_RESULT = {
  tools: [
    { name: 'echo', description: 'echoes input', inputSchema: { type: 'object' } },
    { name: 'add', description: 'adds numbers', inputSchema: { type: 'object' } },
  ],
};

describe('MCPClient — listTools', () => {
  it('returns the tools array from a tools/list response', async () => {
    const c = new MCPClient(mockTransport((req) => (req.method === 'tools/list' ? TOOLS_LIST_RESULT : null)));
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'add']);
  });

  it('throws MCPError when result missing tools[]', async () => {
    const c = new MCPClient(mockTransport(() => ({ other: 'shape' })));
    await expect(c.listTools()).rejects.toBeInstanceOf(MCPError);
  });

  it('propagates JSON-RPC error response as MCPError', async () => {
    const c = new MCPClient(mockTransport(() => ({ error: { code: -32601, message: 'method not found' } })));
    await expect(c.listTools()).rejects.toBeInstanceOf(MCPError);
  });
});

describe('MCPClient — callTool', () => {
  it('returns content blocks from a tools/call response', async () => {
    const c = new MCPClient(
      mockTransport(() => ({
        content: [{ type: 'text', text: 'hello' }],
      })),
    );
    const out = await c.callTool('echo', { text: 'hi' });
    expect(out.content).toHaveLength(1);
    expect(out.content[0]!.text).toBe('hello');
    expect(out.isError).toBeUndefined();
  });

  it('flags isError when server returns isError:true', async () => {
    const c = new MCPClient(
      mockTransport(() => ({
        content: [{ type: 'text', text: 'oops' }],
        isError: true,
      })),
    );
    const out = await c.callTool('broken', {});
    expect(out.isError).toBe(true);
  });

  it('throws when content is missing', async () => {
    const c = new MCPClient(mockTransport(() => ({ no_content: true })));
    await expect(c.callTool('x', {})).rejects.toBeInstanceOf(MCPError);
  });
});

describe('MCPToolRegistry', () => {
  it('rejects invalid server names', async () => {
    const r = new MCPToolRegistry();
    const c = new MCPClient(mockTransport(() => TOOLS_LIST_RESULT));
    await expect(r.addServer('bad name', c)).rejects.toThrow();
    await expect(r.addServer('', c)).rejects.toThrow();
  });

  it('rejects duplicate server registration', async () => {
    const r = new MCPToolRegistry();
    await r.addServer('a', new MCPClient(mockTransport(() => TOOLS_LIST_RESULT)));
    await expect(
      r.addServer('a', new MCPClient(mockTransport(() => TOOLS_LIST_RESULT))),
    ).rejects.toThrow();
  });

  it('exposes registered tools with server-prefixed names', async () => {
    const r = new MCPToolRegistry();
    await r.addServer('weather', new MCPClient(mockTransport(() => TOOLS_LIST_RESULT)));
    const defs = r.toolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(['weather__echo', 'weather__add']);
  });

  it('invoke() returns concatenated text content', async () => {
    const r = new MCPToolRegistry();
    await r.addServer(
      'srv',
      new MCPClient(
        mockTransport((req) => {
          if (req.method === 'tools/list') return TOOLS_LIST_RESULT;
          // tools/call
          return { content: [{ type: 'text', text: 'part 1.' }, { type: 'text', text: ' part 2' }] };
        }),
      ),
    );
    const defs = r.toolDefinitions();
    const result = await defs[0]!.invoke({ x: 1 });
    expect(result).toBe('part 1. part 2');
  });

  it('invoke() throws if tool returns isError', async () => {
    const r = new MCPToolRegistry();
    await r.addServer(
      'srv',
      new MCPClient(
        mockTransport((req) => {
          if (req.method === 'tools/list') return TOOLS_LIST_RESULT;
          return { content: [{ type: 'text', text: 'oops' }], isError: true };
        }),
      ),
    );
    const defs = r.toolDefinitions();
    await expect(defs[0]!.invoke({})).rejects.toBeInstanceOf(MCPError);
  });

  it('closeAll() clears registered tools', async () => {
    const r = new MCPToolRegistry();
    await r.addServer('srv', new MCPClient(mockTransport(() => TOOLS_LIST_RESULT)));
    expect(r.toolDefinitions().length).toBeGreaterThan(0);
    await r.closeAll();
    expect(r.toolDefinitions()).toEqual([]);
  });
});
