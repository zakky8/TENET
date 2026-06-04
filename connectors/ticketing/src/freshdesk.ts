import { verifyHmacSha256 } from './hmac.js';
import {
  type TicketingConnector,
  type TicketingEvent,
  type TicketingHttp,
  TicketingSignatureError,
} from './types.js';

export interface FreshdeskOptions {
  signingSecret: string;
  /** Subdomain (e.g. 'mycompany' for mycompany.freshdesk.com). */
  subdomain: string;
  /** Freshdesk API key. */
  apiKey: string;
  /** Stable tenant id. */
  tenantId: string;
}

export function freshdeskConnector(http: TicketingHttp, opts: FreshdeskOptions): TicketingConnector {
  if (!opts.signingSecret) throw new Error('freshdeskConnector: signingSecret required');
  if (!opts.subdomain) throw new Error('freshdeskConnector: subdomain required');
  if (!opts.apiKey) throw new Error('freshdeskConnector: apiKey required');
  if (!opts.tenantId) throw new Error('freshdeskConnector: tenantId required');
  const baseUrl = `https://${opts.subdomain}.freshdesk.com/api/v2`;
  // Freshdesk uses basic auth with apiKey:X (any pwd works)
  const basic = Buffer.from(`${opts.apiKey}:X`).toString('base64');

  return {
    vendor: 'freshdesk',
    verifyAndParse({ body, headers }) {
      const sig = headers['x-freshdesk-signature'] ?? headers['X-Freshdesk-Signature'];
      if (!sig) throw new TicketingSignatureError('missing X-Freshdesk-Signature header');
      // Freshdesk uses hex-encoded HMAC-SHA256 of the body.
      if (!verifyHmacSha256(opts.signingSecret, body, sig, 'hex')) {
        throw new TicketingSignatureError('freshdesk webhook signature mismatch');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return null;
      }
      const ticket = (parsed as { freshdesk_webhook?: unknown }).freshdesk_webhook as Record<string, unknown> | undefined;
      if (!ticket) return null;
      const conversationId = String(ticket['ticket_id'] ?? ticket['id'] ?? '');
      const userId = String(ticket['requester_id'] ?? '');
      const text = String(ticket['description_text'] ?? ticket['note_body_text'] ?? '');
      const receivedAt = Date.now();
      if (!conversationId || !text) return null;
      return {
        vendor: 'freshdesk',
        tenantId: opts.tenantId,
        conversationId,
        userId,
        text,
        receivedAt,
      };
    },
    async postReply({ conversationId, text, signal }) {
      const url = `${baseUrl}/tickets/${encodeURIComponent(conversationId)}/notes`;
      const init: Parameters<TicketingHttp['fetch']>[1] = {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body: text, private: false }),
        ...(signal !== undefined ? { signal } : {}),
      };
      const res = await http.fetch(url, init);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`freshdesk postReply ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    },
  };
}
