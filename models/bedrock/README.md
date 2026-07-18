# @tenet/models-bedrock

AWS Bedrock ChatModel adapter for the Anthropic Claude family. Implements `ChatModel` from `@tenet/core`.

**No AWS SDK dependency.** The adapter takes an injected `BedrockInvoker` so callers wire their own `@aws-sdk/client-bedrock-runtime` client (or a gateway in front of Bedrock).

```ts
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { AnthropicOnBedrockChatModel, type BedrockInvoker } from '@tenet/models-bedrock';

const client = new BedrockRuntimeClient({ region: 'us-east-1' });
const invoker: BedrockInvoker = {
  async invokeModel({ modelId, body, signal }) {
    const cmd = new InvokeModelCommand({ modelId, body });
    const res = await client.send(cmd, { abortSignal: signal });
    return { body: new TextDecoder().decode(res.body) };
  },
};
const model = new AnthropicOnBedrockChatModel(invoker, {
  modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
});
```
