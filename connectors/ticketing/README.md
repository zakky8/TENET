# @tenet/connectors-ticketing

Webhook receivers + reply posters for **Zendesk Sunshine Conversations · Intercom · Freshdesk · ServiceNow**.

Each vendor exposes a `TicketingConnector` with two methods:
- `verifyAndParse({body, headers})` — verifies HMAC-SHA256 webhook signature (constant-time compare via `node:crypto.timingSafeEqual`) and returns a `TicketingEvent` for the agent runtime.
- `postReply({conversationId, text, signal})` — posts the agent-generated reply via the vendor's REST API.

No vendor SDK as a hard dep. Inject a fetch-compatible HTTP client.

```ts
import { intercomConnector } from '@tenet/connectors-ticketing';

const ic = intercomConnector(http, {
  signingSecret: process.env.INTERCOM_SECRET!,
  accessToken: process.env.INTERCOM_TOKEN!,
  adminId: '12345',
  tenantId: 'tenant-A',
});
```
