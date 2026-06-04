import { verifyHmacSha256 } from './hmac.js';
import {
  type TicketingConnector,
  type TicketingEvent,
  type TicketingHttp,
  TicketingSignatureError,
} from './types.js';

export interface ZendeskOptions {
  signingSecret: string;
  /** Subdomain (e.g. 'mycompany' for mycompany.zendesk.com). */
  subdomain: string;
  /** Email of API user. */
  email: string;
  /** API token. */
  apiToken: string;
  /** Stable tenant id this connector is bound to. */
  tenantId: string;
}

export function zendeskConnector(http: TicketingHttp, opts: ZendeskOptions): TicketingConnector {
  if (!opts.signingSecret) throw new Error('zendeskConnector: signingSecret required');
  if (!opts.subdomain) throw new Error('zendeskConnector: subdomain required');
  if (!opts.tenantId) throw new Error('zendeskConnector: tenantId required');
  const baseUrl = `https://${opts.subdomain}.zendesk.com/api/v2`;
  const basic = Buffer.from(`${opts.email}/token:${opts.apiToken}`).toString('base64');

  return {
    vendor: 'zendesk',
    verifyAndParse({ body, headers }) {
      // Zendesk Sunshine Conversations: HMAC of body, header
      // 'X-Zendesk-Webhook-Signature' (base64-encoded).
      const sig = headers['x-zendesk-webhook-signature'] ?? headers['X-Zendesk-Webhook-Signature'];
      if (!sig) throw new TicketingSignatureError('missing X-Zendesk-Webhook-Signature header');
      if (!verifyHmacSha256(opts.signingSecret, body, sig, 'base64')) {
        throw new TicketingSignatureError('zendesk webhook signature mismatch');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return null;
      }
      const event = (parsed as { event?: { type?: unknown } }).event;
      if (!event || (event.type !== 'message:appUser' && event.type !== 'conversation:create')) return null;
      const data = (parsed as { event?: { payload?: unknown } }).event!.payload as Record<string, unknown> | undefined;
      if (!data) return null;
      const conversation = data.conversation as { id?: unknown } | undefined;
      const author = data.message as { author?: { userId?: unknown }; content?: { text?: unknown }; received?: unknown } | undefined;
      const conversationId = String(conversation?.id ?? '');
      const userId = String(author?.author?.userId ?? '');
      const text = String(author?.content?.text ?? '');
      const receivedAt = typeof author?.received === 'number' ? author.received * 1000 : Date.now();
      if (!conversationId || !text) return null;
      const ev: TicketingEvent = {
        vendor: 'zendesk',
        tenantId: opts.tenantId,
        conversationId,
        userId,
        text,
        receivedAt,
      };
      return ev;
    },
    async postReply({ conversationId, text, signal }) {
      const url = `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/messages`;
      const init: Parameters<TicketingHttp['fetch']>[1] = {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: { type: 'text', text } }),
        ...(signal !== undefined ? { signal } : {}),
      };
      const res = await http.fetch(url, init);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`zendesk postReply ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    },
  };
}
