import { verifyHmacSha256 } from './hmac.js';
import {
  type TicketingConnector,
  type TicketingEvent,
  type TicketingHttp,
  TicketingSignatureError,
} from './types.js';

export interface ServiceNowOptions {
  signingSecret: string;
  /** Instance subdomain (e.g. 'dev123' for dev123.service-now.com). */
  instance: string;
  /** Basic-auth user. */
  username: string;
  /** Basic-auth password. */
  password: string;
  /** Stable tenant id. */
  tenantId: string;
  /** Table the inbound case belongs to (sn_customerservice_case, etc.). Default 'incident'. */
  table?: string;
}

export function servicenowConnector(http: TicketingHttp, opts: ServiceNowOptions): TicketingConnector {
  if (!opts.signingSecret) throw new Error('servicenowConnector: signingSecret required');
  if (!opts.instance) throw new Error('servicenowConnector: instance required');
  if (!opts.username) throw new Error('servicenowConnector: username required');
  if (!opts.password) throw new Error('servicenowConnector: password required');
  if (!opts.tenantId) throw new Error('servicenowConnector: tenantId required');
  const table = opts.table ?? 'incident';
  const baseUrl = `https://${opts.instance}.service-now.com/api/now`;
  const basic = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');

  return {
    vendor: 'servicenow',
    verifyAndParse({ body, headers }) {
      const sig = headers['x-servicenow-signature'] ?? headers['X-ServiceNow-Signature'];
      if (!sig) throw new TicketingSignatureError('missing X-ServiceNow-Signature header');
      if (!verifyHmacSha256(opts.signingSecret, body, sig, 'hex')) {
        throw new TicketingSignatureError('servicenow webhook signature mismatch');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return null;
      }
      const record = (parsed as { record?: unknown }).record as Record<string, unknown> | undefined;
      if (!record) return null;
      const conversationId = String(record['sys_id'] ?? '');
      const userId = String(record['caller_id'] ?? record['opened_by'] ?? '');
      const text = String(record['description'] ?? record['short_description'] ?? '');
      const receivedAt = typeof record['sys_created_on'] === 'string'
        ? Date.parse(record['sys_created_on'] as string) || Date.now()
        : Date.now();
      if (!conversationId || !text) return null;
      return {
        vendor: 'servicenow',
        tenantId: opts.tenantId,
        conversationId,
        userId,
        text,
        receivedAt,
      };
    },
    async postReply({ conversationId, text, signal }) {
      const url = `${baseUrl}/table/${encodeURIComponent(table)}/${encodeURIComponent(conversationId)}/comments`;
      const init: Parameters<TicketingHttp['fetch']>[1] = {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ comments: text }),
        ...(signal !== undefined ? { signal } : {}),
      };
      const res = await http.fetch(url, init);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`servicenow postReply ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    },
  };
}
