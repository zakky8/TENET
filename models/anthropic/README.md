# @tenet/models-anthropic

Direct Anthropic API ChatModel — talks to `https://api.anthropic.com/v1/messages` directly, NOT via Bedrock. Companion to `@tenet/models-bedrock`.

No `@anthropic-ai/sdk` hard dep. Inject any fetch-compatible HTTP client. Apps wire their own retry / proxy / observability middleware that way.

```ts
const model = new AnthropicChatModel(
  { fetch: globalThis.fetch.bind(globalThis) as any },
  { apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-opus-4-8-20260528' },
);
```
