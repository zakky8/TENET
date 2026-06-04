# @tenet/tools-mcp

[Model Context Protocol](https://modelcontextprotocol.io) tool wiring. Ships JSON-RPC 2.0 types, a transport contract, `MCPClient`, and `MCPToolRegistry` that exposes MCP-discovered tools as `ToolDefinition` records for an agent's tool-use loop.

No MCP SDK as a hard dep. Apps plug a transport (stdio, Streamable HTTP, etc.) per the 2026-07-28 spec RC — see [`docs/RESEARCH-PASS-2.md §D2`](../../docs/RESEARCH-PASS-2.md).
