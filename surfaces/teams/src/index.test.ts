import {
  TeamsSurface,
  renderAdaptiveCard,
  type TeamsActivity,
  type TeamsClient,
  type TeamsOutboundActivity,
  type RateLimitGate,
} from './index.js';

const BOT = 'bot:1';

function mockClient(captures: TeamsOutboundActivity[] = []): TeamsClient {
  return {
    async sendActivity(act) {
      captures.push(act);
      return { activityId: 'a-1' };
    },
  };
}

function act(extras: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: 'message',
    id: 'a-1',
    timestamp: '2026-06-04T12:00:00.000Z',
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
    conversation: { id: 'conv-1', tenantId: 'tenant-X' },
    from: { id: 'user-1' },
    recipient: { id: BOT },
    text: 'hello bot',
    ...extras,
  };
}

describe('renderAdaptiveCard', () => {
  it('returns v1.5 card with single TextBlock when no citations', () => {
    const c = renderAdaptiveCard('Hi', []) as { body: unknown[]; version: string };
    expect(c.version).toBe('1.5');
    expect(c.body).toHaveLength(1);
  });

  it('appends Sources section when citations present', () => {
    const c = renderAdaptiveCard('Hi', [{ sourceId: 'https://example.com', quote: 'q' }]) as {
      body: Array<{ type: string; text?: string }>;
    };
    // body: TextBlock + 'Sources:' header + 1 source line
    expect(c.body.length).toBe(3);
    expect(c.body[1]!.text).toContain('Sources');
  });
});

describe('TeamsSurface — construction', () => {
  it('requires botUserId', () => {
    expect(() => new TeamsSurface({ client: mockClient(), botUserId: '' })).toThrow();
  });
});

describe('TeamsSurface — normalize()', () => {
  const s = new TeamsSurface({ client: mockClient(), botUserId: BOT });

  it('produces NormalizedEvent for a user message', () => {
    const ev = s.normalize(act());
    expect(ev!.surface).toBe('teams');
    expect(ev!.tenantId).toBe('tenant-X');
    expect(ev!.conversationId).toBe('conv-1');
    expect(ev!.userId).toBe('user-1');
    expect(ev!.text).toBe('hello bot');
    expect(ev!.receivedAt).toBe(Date.parse('2026-06-04T12:00:00.000Z'));
    expect(ev!.metadata?.serviceUrl).toBe('https://smba.trafficmanager.net/teams/');
  });

  it('drops non-message activity types', () => {
    expect(s.normalize(act({ type: 'typing' }))).toBeNull();
    expect(s.normalize(act({ type: 'conversationUpdate' }))).toBeNull();
  });

  it('drops messages from the bot itself', () => {
    expect(s.normalize(act({ from: { id: BOT } }))).toBeNull();
  });

  it('drops empty / whitespace messages', () => {
    expect(s.normalize(act({ text: '   ' }))).toBeNull();
    expect(s.normalize(act({ text: undefined }))).toBeNull();
  });

  it('returns null when no tenantId resolvable', () => {
    expect(
      s.normalize(act({ conversation: { id: 'c' } })),
    ).toBeNull();
  });

  it('uses defaultTenantId when activity lacks one', () => {
    const fallback = new TeamsSurface({ client: mockClient(), botUserId: BOT, defaultTenantId: 'default-T' });
    const ev = fallback.normalize(act({ conversation: { id: 'c' } }));
    expect(ev!.tenantId).toBe('default-T');
  });

  it('attaches teamId to metadata when channelData present', () => {
    const ev = s.normalize(act({ channelData: { teamId: 'team-1' } }));
    expect(ev!.metadata?.teamId).toBe('team-1');
  });
});

describe('TeamsSurface — send()', () => {
  it('sends Adaptive Card attachment + fallback text', async () => {
    const captures: TeamsOutboundActivity[] = [];
    const s = new TeamsSurface({ client: mockClient(captures), botUserId: BOT });
    const ev = s.normalize(act())!;
    await s.send({ event: ev, reply: { text: 'hi', citations: [] } });
    expect(captures[0]!.conversationId).toBe('conv-1');
    expect(captures[0]!.text).toBe('hi');
    expect(captures[0]!.attachments).toHaveLength(1);
    const att = captures[0]!.attachments![0] as { contentType: string };
    expect(att.contentType).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('throws when event.metadata.serviceUrl missing', async () => {
    const s = new TeamsSurface({ client: mockClient(), botUserId: BOT });
    const fakeEv = { ...s.normalize(act())!, metadata: {} };
    await expect(s.send({ event: fakeEv, reply: { text: 'x', citations: [] } })).rejects.toThrow(/serviceUrl/);
  });

  it('invokes rate-limit gate before sendActivity', async () => {
    const order: string[] = [];
    const rate: RateLimitGate = { async schedule() { order.push('rate'); } };
    const client: TeamsClient = {
      async sendActivity() {
        order.push('send');
        return { activityId: 'x' };
      },
    };
    const s = new TeamsSurface({ client, rateLimit: rate, botUserId: BOT });
    const ev = s.normalize(act())!;
    await s.send({ event: ev, reply: { text: 'ok', citations: [] } });
    expect(order).toEqual(['rate', 'send']);
  });
});
