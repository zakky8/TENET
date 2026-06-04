import { verifyHmacSha256 } from './hmac.js';
import {
  type TicketingConnector,
  type TicketingEvent,
  type TicketingHttp,
  TicketingSignatureError,
} from './types.js';

export interface IntercomOptions {
  /** Webhook signing secret. */
  signingSecret: string;
  /** Intercom API access token. */
  accessToken: string;
  /** Admin id that posts replies on the bot's behalf. */
  adminId: string;
  /** Stable tenant id. */
  tenantId: string;
  /** Base URL — default https://api.intercom.io. */
  baseUrl?: string;
}

export function intercomConnector(http: TicketingHttp, opts: IntercomOptions): TicketingConnector {
  if (!opts.signingSecret) throw new Error('intercomConnector: signingSecret required');
  if (!opts.accessToken) throw new Error('intercomConnector: accessToken required');
  if (!opts.adminId) throw new Error('intercomConnector: adminId required');
  if (!opts.tenantId) throw new Error('intercomConnector: tenantId required');
  const baseUrl = (opts.baseUrl ?? 'https://api.intercom.io').replace(/\/+$/, '');

  return {
    vendor: 'intercom',
    verifyAndParse({ body, headers }) {
      // Intercom: signature in 'X-Hub-Signature' as 'sha1=...' OR
      // 'X-Hub-Signature-256' as 'sha256=...'. We require the 256 form
      // (sha1 is deprecated). Format: 'sha256=<hex>'.
      const raw = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'];
      if (!raw) throw new TicketingSignatureError('missing X-Hub-Signature-256 header');
      const m = raw.match(/^sha256=(.+)$/);
      if (!m) throw new TicketingSignatureError('malformed signature header');
      if (!verifyHmacSha256(opts.signingSecret, body, m[1]!, 'hex')) {
        throw new TicketingSignatureError('intercom webhook signature mismatch');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return null;
      }
      const topic = (parsed as { topic?: unknown }).topic;
      if (topic !== 'conversation.user.created' && topic !== 'conversation.user.replied') return null;
      const data = (parsed as { data?: { item?: unknown } }).data?.item as Record<string, unknown> | undefined;
      if (!data) return null;
      const conversationId = String(data['id'] ?? '');
      const sourceObj = (data['source'] ?? {}) as Record<string, unknown>;
      const userId = String((sourceObj['author'] as { id?: unknown } | undefined)?.id ?? '');
      const text = String(sourceObj['body'] ?? '').replace(/<[^>]+>/g, ''); // strip basic HTML
      const receivedAt = typeof data['created_at'] === 'number' ? (data['created_at'] as number) * 1000 : Date.now();
      if (!conversationId || !text) return null;
      return {
        vendor: 'intercom',
        tenantId: opts.tenantId,
        conversationId,
        userId,
        text,
        receivedAt,
      };
    },
    async postReply({ conversationId, text, signal }) {
      const url = `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/reply`;
      const init: Parameters<TicketingHttp['fetch']>[1] = {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          message_type: 'comment',
          type: 'admin',
          admin_id: opts.adminId,
          body: text,
        }),
        ...(signal !== undefined ? { signal } : {}),
      };
      const res = await http.fetch(url, init);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`intercom postReply ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    },
  };
}
