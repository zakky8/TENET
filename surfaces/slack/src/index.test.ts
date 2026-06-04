import {
  SlackSurface,
  renderBlocks,
  stripSlackMention,
  tsToMs,
  type SlackClient,
  type SlackEvent,
  type SlackOutboundMessage,
  type RateLimitGate,
} from './index.js';

const BOT = 'UBOT';

function mockClient(captures: SlackOutboundMessage[] = []): SlackClient {
  return {
    async postMessage(msg) {
      captures.push(msg);
      return { ts: '1700000000.000001' };
    },
  };
}

function ev(extras: Partial<SlackEvent> = {}): SlackEvent {
  return {
    ts: '1700000000.000001',
    channel: 'C1',
    user: 'U1',
    teamId: 'T1',
    text: 'hello',
    ...extras,
  };
}

describe('tsToMs', () => {
  it('converts seconds-based Slack ts to ms', () => {
    expect(tsToMs('1700000000.000001')).toBe(1700000000 * 1000);
  });
  it('handles malformed ts as 0', () => {
    expect(tsToMs('garbage')).toBe(0);
  });
});

describe('stripSlackMention', () => {
  it('removes <@BOT> form', () => {
    expect(stripSlackMention('<@UBOT> hello', BOT)).toBe('hello');
  });
  it('removes <@BOT|nickname> form', () => {
    expect(stripSlackMention('<@UBOT|nick> hello', BOT)).toBe('hello');
  });
  it('leaves other users alone', () => {
    expect(stripSlackMention('<@OTHER> hi', BOT)).toBe('<@OTHER> hi');
  });
});

describe('renderBlocks', () => {
  it('returns a single section block when no citations', () => {
    const out = renderBlocks('Hi', []);
    expect(out).toHaveLength(1);
  });
  it('appends a Sources section when citations present', () => {
    const out = renderBlocks('Hi', [{ sourceId: 'https://example.com', quote: 'q' }]);
    expect(out).toHaveLength(2);
    const sourcesBlock = out[1] as { text: { text: string } };
    expect(sourcesBlock.text.text).toContain('*Sources:*');
    expect(sourcesBlock.text.text).toContain('<https://example.com|q>');
  });
  it('strips < > from quote labels (Slack mrkdwn would parse them)', () => {
    const out = renderBlocks('Hi', [{ sourceId: 'u', quote: '<b>danger</b>' }]);
    const block = out[1] as { text: { text: string } };
    expect(block.text.text).not.toContain('<b>');
  });
});

describe('SlackSurface — construction', () => {
  it('requires tenantId and botUserId', () => {
    expect(() => new SlackSurface({ client: mockClient(), tenantId: '', botUserId: BOT })).toThrow();
    expect(() => new SlackSurface({ client: mockClient(), tenantId: 'T', botUserId: '' })).toThrow();
  });
  it('defaults to internal mode', () => {
    const s = new SlackSurface({ client: mockClient(), tenantId: 'T', botUserId: BOT });
    expect(s.mode).toBe('internal');
  });
  it('honors explicit marketplace mode', () => {
    const s = new SlackSurface({ client: mockClient(), tenantId: 'T', botUserId: BOT, mode: 'marketplace' });
    expect(s.mode).toBe('marketplace');
  });
});

describe('SlackSurface — normalize()', () => {
  const s = new SlackSurface({ client: mockClient(), tenantId: 'T', botUserId: BOT });

  it('produces NormalizedEvent for a user message', () => {
    const out = s.normalize(ev());
    expect(out!.surface).toBe('slack');
    expect(out!.tenantId).toBe('T');
    expect(out!.conversationId).toBe('C1');
    expect(out!.userId).toBe('U1');
    expect(out!.text).toBe('hello');
  });

  it('drops messages with subtype (bot_message, channel_join, etc.)', () => {
    expect(s.normalize(ev({ subtype: 'bot_message' }))).toBeNull();
  });

  it('drops self-messages from the bot user', () => {
    expect(s.normalize(ev({ user: BOT }))).toBeNull();
  });

  it('drops empty messages', () => {
    expect(s.normalize(ev({ text: '   ' }))).toBeNull();
  });

  it('strips bot mention from text', () => {
    expect(s.normalize(ev({ text: `<@${BOT}> what is X` }))!.text).toBe('what is X');
  });

  it('attaches teamId + threadTs to metadata', () => {
    const out = s.normalize(ev({ threadTs: '1700.0' }));
    expect(out!.metadata?.teamId).toBe('T1');
    expect(out!.metadata?.threadTs).toBe('1700.0');
  });

  it('drops messages without bot mention when requireMention=true', () => {
    const strict = new SlackSurface({
      client: mockClient(),
      tenantId: 'T',
      botUserId: BOT,
      requireMention: true,
    });
    expect(strict.normalize(ev())).toBeNull();
    expect(strict.normalize(ev({ text: `<@${BOT}> ping` }))).not.toBeNull();
  });
});

describe('SlackSurface — send()', () => {
  it('passes blocks + fallback text', async () => {
    const captures: SlackOutboundMessage[] = [];
    const s = new SlackSurface({ client: mockClient(captures), tenantId: 'T', botUserId: BOT });
    const event = s.normalize(ev())!;
    await s.send({
      event,
      reply: { text: 'hello', citations: [{ sourceId: 'u', quote: 'q' }] },
    });
    expect(captures[0]!.channel).toBe('C1');
    expect(captures[0]!.text).toBe('hello');
    expect(captures[0]!.blocks).toBeDefined();
  });

  it('invokes rate-limit gate before postMessage', async () => {
    const order: string[] = [];
    const rate: RateLimitGate = { async schedule() { order.push('rate'); } };
    const client: SlackClient = {
      async postMessage() {
        order.push('send');
        return { ts: 'x' };
      },
    };
    const s = new SlackSurface({ client, rateLimit: rate, tenantId: 'T', botUserId: BOT });
    const event = s.normalize(ev())!;
    await s.send({ event, reply: { text: 'ok', citations: [] } });
    expect(order).toEqual(['rate', 'send']);
  });
});
