import {
  DiscordSurface,
  renderMarkdown,
  stripMentions,
  type DiscordClient,
  type DiscordOutboundMessage,
  type RateLimitGate,
} from './index.js';

function mockClient(captures: DiscordOutboundMessage[] = []): DiscordClient {
  return {
    async sendMessage(msg) {
      captures.push(msg);
      return { messageId: 'mid' };
    },
  };
}

const BOT_ID = 'bot-1';
const FAKE_USER_ID = 'user-2';
const FAKE_CHANNEL_ID = 'ch-1';

function msg(extras: Partial<Parameters<DiscordSurface['normalize']>[0]> = {}): Parameters<DiscordSurface['normalize']>[0] {
  return {
    id: 'm-1',
    authorId: FAKE_USER_ID,
    authorIsBot: false,
    channelId: FAKE_CHANNEL_ID,
    createdAtMs: 1_000,
    content: 'hello',
    mentions: [],
    ...extras,
  };
}

describe('stripMentions', () => {
  it('removes <@123> and <@!123> mentions for given user ids', () => {
    expect(stripMentions('<@bot-1> hello', ['bot-1'])).toBe('hello');
    expect(stripMentions('<@!bot-1> hi', ['bot-1'])).toBe('hi');
  });
  it('leaves mentions for other users intact', () => {
    expect(stripMentions('<@other> hi', ['bot-1'])).toBe('<@other> hi');
  });
});

describe('renderMarkdown', () => {
  it('returns text alone when no citations', () => {
    expect(renderMarkdown('hello', [])).toBe('hello');
  });

  it('appends Markdown sources block', () => {
    const out = renderMarkdown('Answer', [
      { sourceId: 'https://example.com', quote: 'verbatim' },
    ]);
    expect(out).toMatch(/\*\*Sources:\*\*/);
    expect(out).toMatch(/\[verbatim\]\(https:\/\/example\.com\)/);
  });
});

describe('DiscordSurface — construction', () => {
  it('requires tenantId and botUserId', () => {
    expect(() => new DiscordSurface({ client: mockClient(), tenantId: '', botUserId: BOT_ID })).toThrow();
    expect(() => new DiscordSurface({ client: mockClient(), tenantId: 'T', botUserId: '' })).toThrow();
  });
});

describe('DiscordSurface — normalize()', () => {
  const s = new DiscordSurface({ client: mockClient(), tenantId: 'T', botUserId: BOT_ID });

  it('produces NormalizedEvent for a regular user message', () => {
    const ev = s.normalize(msg());
    expect(ev!.surface).toBe('discord');
    expect(ev!.tenantId).toBe('T');
    expect(ev!.conversationId).toBe(FAKE_CHANNEL_ID);
    expect(ev!.userId).toBe(FAKE_USER_ID);
    expect(ev!.text).toBe('hello');
  });

  it('drops bot messages', () => {
    expect(s.normalize(msg({ authorIsBot: true }))).toBeNull();
  });

  it('drops self-messages', () => {
    expect(s.normalize(msg({ authorId: BOT_ID }))).toBeNull();
  });

  it('drops empty messages', () => {
    expect(s.normalize(msg({ content: '   ' }))).toBeNull();
  });

  it('strips bot mentions from text', () => {
    const ev = s.normalize(msg({ content: `<@${BOT_ID}> what is X`, mentions: [BOT_ID] }));
    expect(ev!.text).toBe('what is X');
  });

  it('drops messages without bot mention when requireMention=true', () => {
    const strict = new DiscordSurface({
      client: mockClient(),
      tenantId: 'T',
      botUserId: BOT_ID,
      requireMention: true,
    });
    expect(strict.normalize(msg())).toBeNull();
    expect(strict.normalize(msg({ content: `<@${BOT_ID}> hi`, mentions: [BOT_ID] }))).not.toBeNull();
  });

  it('attaches guildId to metadata when present', () => {
    const ev = s.normalize(msg({ guildId: 'g-1' }));
    expect(ev!.metadata?.guildId).toBe('g-1');
  });
});

describe('DiscordSurface — send()', () => {
  it('renders Markdown content with citations', async () => {
    const captures: DiscordOutboundMessage[] = [];
    const s = new DiscordSurface({ client: mockClient(captures), tenantId: 'T', botUserId: BOT_ID });
    const ev = s.normalize(msg())!;
    await s.send({
      event: ev,
      reply: {
        text: 'Hi',
        citations: [{ sourceId: 'https://example.com', quote: 'q' }],
      },
    });
    expect(captures[0]!.channelId).toBe(FAKE_CHANNEL_ID);
    expect(captures[0]!.content).toContain('**Sources:**');
  });

  it('invokes rate-limit gate before sending', async () => {
    const order: string[] = [];
    const rate: RateLimitGate = { async schedule() { order.push('rate'); } };
    const client: DiscordClient = {
      async sendMessage() {
        order.push('send');
        return { messageId: 'x' };
      },
    };
    const s = new DiscordSurface({ client, rateLimit: rate, tenantId: 'T', botUserId: BOT_ID });
    const ev = s.normalize(msg())!;
    await s.send({ event: ev, reply: { text: 'ok', citations: [] } });
    expect(order).toEqual(['rate', 'send']);
  });
});
