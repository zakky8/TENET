import { createHmac } from 'node:crypto';
import {
  verifyHmacSha256,
  zendeskConnector,
  intercomConnector,
  freshdeskConnector,
  servicenowConnector,
  TicketingSignatureError,
  type TicketingHttp,
} from './index.js';

const SECRET = 'shared-test-secret-1234567890';

type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };
function mockHttp(reply: { status: number; body: string }, calls: Call[] = []): TicketingHttp {
  return {
    async fetch(url, init) {
      calls.push({ url, init });
      return { status: reply.status, async text() { return reply.body; } };
    },
  };
}

function hexSig(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}
function b64Sig(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64');
}

describe('verifyHmacSha256', () => {
  it('accepts a valid hex signature', () => {
    expect(verifyHmacSha256(SECRET, 'hello', hexSig('hello'), 'hex')).toBe(true);
  });
  it('rejects bad hex signature', () => {
    expect(verifyHmacSha256(SECRET, 'hello', 'deadbeef', 'hex')).toBe(false);
  });
  it('accepts a valid base64 signature', () => {
    expect(verifyHmacSha256(SECRET, 'hello', b64Sig('hello'), 'base64')).toBe(true);
  });
  it('rejects empty signature', () => {
    expect(verifyHmacSha256(SECRET, 'hello', '', 'hex')).toBe(false);
  });
});

// ── Zendesk ────────────────────────────────────────────────────────────

const ZENDESK_BODY = JSON.stringify({
  event: {
    type: 'message:appUser',
    payload: {
      conversation: { id: 'conv-1' },
      message: {
        author: { userId: 'user-1' },
        content: { text: 'hello from zendesk' },
        received: 1700000000,
      },
    },
  },
});

describe('zendeskConnector', () => {
  const c = zendeskConnector(mockHttp({ status: 200, body: '{}' }), {
    signingSecret: SECRET,
    subdomain: 'mycompany',
    email: 'agent@example.com',
    apiToken: 'tok',
    tenantId: 'tenant-A',
  });

  it('verifyAndParse: returns event on good signature', () => {
    const ev = c.verifyAndParse({
      body: ZENDESK_BODY,
      headers: { 'x-zendesk-webhook-signature': b64Sig(ZENDESK_BODY) },
    });
    expect(ev?.vendor).toBe('zendesk');
    expect(ev?.conversationId).toBe('conv-1');
    expect(ev?.text).toBe('hello from zendesk');
    expect(ev?.tenantId).toBe('tenant-A');
  });

  it('verifyAndParse: throws on bad signature', () => {
    expect(() =>
      c.verifyAndParse({ body: ZENDESK_BODY, headers: { 'x-zendesk-webhook-signature': 'bad' } }),
    ).toThrow(TicketingSignatureError);
  });

  it('postReply: POSTs Sunshine Conversations message', async () => {
    const calls: Call[] = [];
    const con = zendeskConnector(mockHttp({ status: 200, body: '{}' }, calls), {
      signingSecret: SECRET, subdomain: 'mc', email: 'a@b', apiToken: 'k', tenantId: 'T',
    });
    await con.postReply({ conversationId: 'conv-1', text: 'reply' });
    expect(calls[0]!.url).toContain('/conversations/conv-1/messages');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ message: { type: 'text', text: 'reply' } });
  });
});

// ── Intercom ───────────────────────────────────────────────────────────

const INTERCOM_BODY = JSON.stringify({
  topic: 'conversation.user.created',
  data: {
    item: {
      id: 'icv-1',
      created_at: 1700000000,
      source: {
        body: '<p>hello from intercom</p>',
        author: { id: 'icu-1' },
      },
    },
  },
});

describe('intercomConnector', () => {
  const c = intercomConnector(mockHttp({ status: 200, body: '{}' }), {
    signingSecret: SECRET,
    accessToken: 'ic-tok',
    adminId: '999',
    tenantId: 'tenant-B',
  });

  it('verifyAndParse: returns event on good signature', () => {
    const ev = c.verifyAndParse({
      body: INTERCOM_BODY,
      headers: { 'x-hub-signature-256': `sha256=${hexSig(INTERCOM_BODY)}` },
    });
    expect(ev?.vendor).toBe('intercom');
    expect(ev?.conversationId).toBe('icv-1');
    expect(ev?.text).toBe('hello from intercom'); // HTML stripped
  });

  it('verifyAndParse: throws on malformed signature header (no sha256= prefix)', () => {
    expect(() =>
      c.verifyAndParse({ body: INTERCOM_BODY, headers: { 'x-hub-signature-256': 'oops' } }),
    ).toThrow(TicketingSignatureError);
  });

  it('postReply: POSTs to /conversations/{id}/reply with admin shape', async () => {
    const calls: Call[] = [];
    const con = intercomConnector(mockHttp({ status: 200, body: '{}' }, calls), {
      signingSecret: SECRET, accessToken: 'tok', adminId: '999', tenantId: 'T',
    });
    await con.postReply({ conversationId: 'icv-1', text: 'reply' });
    expect(calls[0]!.url).toContain('/conversations/icv-1/reply');
    expect(JSON.parse(calls[0]!.init.body!)).toMatchObject({
      message_type: 'comment',
      type: 'admin',
      admin_id: '999',
      body: 'reply',
    });
  });
});

// ── Freshdesk ──────────────────────────────────────────────────────────

const FRESHDESK_BODY = JSON.stringify({
  freshdesk_webhook: {
    ticket_id: '42',
    requester_id: 'req-1',
    description_text: 'hello from freshdesk',
  },
});

describe('freshdeskConnector', () => {
  const c = freshdeskConnector(mockHttp({ status: 200, body: '{}' }), {
    signingSecret: SECRET, subdomain: 'mycompany', apiKey: 'fd-key', tenantId: 'tenant-C',
  });
  it('verifyAndParse: returns event on good signature', () => {
    const ev = c.verifyAndParse({
      body: FRESHDESK_BODY,
      headers: { 'x-freshdesk-signature': hexSig(FRESHDESK_BODY) },
    });
    expect(ev?.vendor).toBe('freshdesk');
    expect(ev?.conversationId).toBe('42');
    expect(ev?.text).toBe('hello from freshdesk');
  });
  it('postReply: POSTs /tickets/{id}/notes', async () => {
    const calls: Call[] = [];
    const con = freshdeskConnector(mockHttp({ status: 200, body: '{}' }, calls), {
      signingSecret: SECRET, subdomain: 'mc', apiKey: 'k', tenantId: 'T',
    });
    await con.postReply({ conversationId: '42', text: 'reply' });
    expect(calls[0]!.url).toContain('/tickets/42/notes');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ body: 'reply', private: false });
  });
});

// ── ServiceNow ─────────────────────────────────────────────────────────

const SNOW_BODY = JSON.stringify({
  record: {
    sys_id: 'snow-uuid-1',
    caller_id: 'snow-user',
    description: 'hello from servicenow',
    sys_created_on: '2026-06-04 12:00:00',
  },
});

describe('servicenowConnector', () => {
  const c = servicenowConnector(mockHttp({ status: 200, body: '{}' }), {
    signingSecret: SECRET, instance: 'dev123', username: 'u', password: 'p', tenantId: 'tenant-D',
  });
  it('verifyAndParse: returns event on good signature', () => {
    const ev = c.verifyAndParse({
      body: SNOW_BODY,
      headers: { 'x-servicenow-signature': hexSig(SNOW_BODY) },
    });
    expect(ev?.vendor).toBe('servicenow');
    expect(ev?.conversationId).toBe('snow-uuid-1');
    expect(ev?.text).toBe('hello from servicenow');
  });
  it('postReply: POSTs to table comments endpoint', async () => {
    const calls: Call[] = [];
    const con = servicenowConnector(mockHttp({ status: 200, body: '{}' }, calls), {
      signingSecret: SECRET, instance: 'dev123', username: 'u', password: 'p', tenantId: 'T', table: 'incident',
    });
    await con.postReply({ conversationId: 'snow-uuid-1', text: 'reply' });
    expect(calls[0]!.url).toContain('/table/incident/snow-uuid-1/comments');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ comments: 'reply' });
  });
});
