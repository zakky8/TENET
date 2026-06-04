# @tenet/surface-rest

OpenAPI 3.1 REST surface — JSON over HTTP, JWT, optional SSE streaming.

Endpoints:
- `POST /v1/converse` — single-turn invocation; returns `{reply, citations, conversationId}`
- `POST /v1/converse/stream` — same but SSE-streamed

Framework-agnostic — returns `{status, headers, body}` that Express / Fastify / Hono / Cloudflare Workers wire to native Response. The `OPENAPI_SPEC` constant is the static schema you serve at `/openapi.json`.
