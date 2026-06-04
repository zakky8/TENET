# @tenet/tools-mcp-gateway

Per-tenant tool allow-list + **OAuth `iss` validation** (RFC 9207 / 2026-07-28 spec RC, SEP-2468) + audit log for MCP tool calls.

Sits in front of `@tenet/tools-mcp`'s `MCPToolRegistry`. The agent's tool-use loop calls `gateway.invoke({tenantId, toolName, args, oauth})` instead of invoking `ToolDefinition.invoke()` directly.
