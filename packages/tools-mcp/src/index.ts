/**
 * MCP-native tool wiring.
 *
 * Model Context Protocol (MCP) — see https://modelcontextprotocol.io.
 * As of 2026-07-28 RC: stateless HTTP core, Streamable HTTP transport
 * with Mcp-Method + Mcp-Name headers, OAuth via iss validation.
 *
 * This package ships:
 *   - JSON-RPC 2.0 request/response types
 *   - MCPTransport interface (transport-agnostic; impls plug in for
 *     stdio, Streamable HTTP, etc.)
 *   - MCPClient — protocol-level convenience over a transport
 *   - MCPToolRegistry — exposes MCP-discovered tools as ToolDefinition
 *     records that the agent's tool-use loop can call
 *
 * No MCP SDK as a hard dep. Transports are slim shapes; production
 * deployments inject the actual stdio / HTTP implementation.
 */

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// ── Transport ───────────────────────────────────────────────────────────

export interface MCPTransport {
  /** Single request → single response. */
  call(req: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>;
  /** Shut down the transport (close pipes / HTTP keep-alive). */
  close(): Promise<void>;
}

// ── Protocol types (subset relevant for tool use) ───────────────────────

export interface MCPToolListItem {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface MCPToolCallResult {
  /** Array of content blocks (text, image, resource). We surface text only. */
  content: ReadonlyArray<{ type: string; text?: string; data?: unknown }>;
  /** Whether the tool reported an application-level error. */
  isError?: boolean;
}

// ── Client ──────────────────────────────────────────────────────────────

export class MCPClient {
  private idCounter = 0;
  constructor(private readonly transport: MCPTransport) {}

  /** List tools the MCP server exposes. */
  async listTools(signal?: AbortSignal): Promise<ReadonlyArray<MCPToolListItem>> {
    const res = await this.call('tools/list', undefined, signal);
    const result = res as { tools?: unknown };
    if (!Array.isArray(result.tools)) {
      throw new MCPError(-32602, 'tools/list result missing tools[]');
    }
    return result.tools.filter(isToolListItem);
  }

  /** Call a named tool. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolCallResult> {
    const res = await this.call('tools/call', { name, arguments: args }, signal);
    if (typeof res !== 'object' || res === null) {
      throw new MCPError(-32602, 'tools/call result must be an object');
    }
    const r = res as { content?: unknown; isError?: unknown };
    if (!Array.isArray(r.content)) {
      throw new MCPError(-32602, 'tools/call result.content must be an array');
    }
    const content = r.content.filter(
      (c): c is { type: string; text?: string; data?: unknown } =>
        c !== null && typeof c === 'object' && typeof (c as { type?: unknown }).type === 'string',
    );
    return {
      content,
      ...(r.isError === true ? { isError: true } : {}),
    };
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  private async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.idCounter,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const res = await this.transport.call(req, signal);
    if ('error' in res) {
      throw new MCPError(res.error.code, res.error.message, res.error.data);
    }
    return res.result;
  }
}

export class MCPError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(`MCP error ${code}: ${message}`);
    this.name = 'MCPError';
  }
}

function isToolListItem(v: unknown): v is MCPToolListItem {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    o.inputSchema !== undefined &&
    typeof o.inputSchema === 'object'
  );
}

// ── Tool definitions for the agent's tool-use loop ──────────────────────

export interface ToolDefinition {
  /** Name as the agent uses it — usually prefixed with server name to disambiguate. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Invoke the tool. Returns the concatenated text content from the MCP response. */
  invoke(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/**
 * Registers MCP server(s) and exposes their tools as ToolDefinition
 * records. Apps' agent runtimes wire toolDefinitions().invoke() into
 * their tool-use loop.
 */
export class MCPToolRegistry {
  private readonly servers = new Map<string, MCPClient>();
  private readonly tools = new Map<string, { client: MCPClient; def: MCPToolListItem }>();

  /** Register a named server. The same name appears as a prefix in tool names. */
  async addServer(name: string, client: MCPClient, signal?: AbortSignal): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
      throw new Error(`addServer: invalid server name ${JSON.stringify(name)}`);
    }
    if (this.servers.has(name)) {
      throw new Error(`addServer: ${name} already registered`);
    }
    this.servers.set(name, client);
    const tools = await client.listTools(signal);
    for (const t of tools) {
      const prefixed = `${name}__${t.name}`;
      this.tools.set(prefixed, { client, def: t });
    }
  }

  /** Return all registered tools as ToolDefinition records. */
  toolDefinitions(): ReadonlyArray<ToolDefinition> {
    const out: ToolDefinition[] = [];
    for (const [name, entry] of this.tools.entries()) {
      const client = entry.client;
      const def = entry.def;
      out.push({
        name,
        description: def.description ?? '',
        inputSchema: def.inputSchema,
        async invoke(args, signal) {
          const res = await client.callTool(def.name, args, signal);
          if (res.isError) {
            throw new MCPError(-1, `tool ${def.name} reported isError`);
          }
          return res.content
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text!)
            .join('');
        },
      });
    }
    return out;
  }

  /** Close all registered servers. */
  async closeAll(): Promise<void> {
    for (const client of this.servers.values()) {
      await client.close().catch(() => {});
    }
    this.servers.clear();
    this.tools.clear();
  }
}

export const VERSION = '0.0.0';
