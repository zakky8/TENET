import {
  TelegramSurface,
  escapeHtml,
  renderHtml,
  type TelegramClient,
  type TelegramOutboundMessage,
  type RateLimitGate,
} from './index.js';

function mockClient(captures: Array<TelegramOutboundMessage> = []): TelegramClient {
  return {
    async sendMessage(msg) {
      captures.push(msg);
      return { messageId: 42 };
    },
  };
}

describe('escapeHtml', () => {
  it('escapes &, <, >, "', () => {
    expect(escapeHtml('< & > "')).toBe('&lt; &amp; &gt; &quot;');
  });

  it('leaves plain text alone', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('renderHtml', () => {
  it('returns escaped body when no citations', () => {
    expect(renderHtml('A <b>tag</b>', [])).toBe('A &lt;b&gt;tag&lt;/b&gt;');
  });

  it('appends Sources block with escaped quote labels', () => {
    const out = renderHtml('Answer', [
      { sourceId: 'https://example.com/<x>', quote: 'verbatim <quote>' },
    ]);
    expect(out).toContain('<b>Sources:</b>');
    expect(out).toContain('&lt;x&gt;');
    expect(out).toContain('&lt;quote&gt;');
  });

  it('uses sourceId as label when quote is missing', () => {
    const out = renderHtml('A', [{ sourceId: 'https://x.com/y', quote: '' }]);
    expect(out).toContain('https://x.com/y');
  });
});

describe('TelegramSurface — construction', () => {
  it('requires tenantId', () => {
    expect(() => new TelegramSurface({ client: mockClient(), tenantId: '' })).toThrow();
  });
});

describe('TelegramSurface — normalize()', () => {
  it('produces NormalizedEvent from text message', () => {
    const s = new TelegramSurface({ client: mockClient(), tenantId: 'T' });
    const ev = s.normalize({
      updateId: 1,
      message: {
        messageId: 1,
        date: 1700000000,
        text: 'hello',
        chat: { id: 100, type: 'private' },
        from: { id: 999 },
      },
    });
    expect(ev).not.toBeNull();
    expect(ev!.surface).toBe('telegram');
    expect(ev!.tenantId).toBe('T');
    expect(ev!.conversationId).toBe('100');
    expect(ev!.userId).toBe('999');
    expect(ev!.text).toBe('hello');
    expect(ev!.receivedAt).toBe(1700000000 * 1000);
  });

  it('returns null for non-text or missing message', () => {
    const s = new TelegramSurface({ client: mockClient(), tenantId: 'T' });
    expect(s.normalize({ updateId: 1 })).toBeNull();
    expect(
      s.normalize({
        updateId: 1,
        message: { messageId: 1, date: 0, chat: { id: 1, type: 'p' } },
      }),
    ).toBeNull();
  });

  it('falls back to chat.id when from.id is absent (anonymous group sender)', () => {
    const s = new TelegramSurface({ client: mockClient(), tenantId: 'T' });
    const ev = s.normalize({
      updateId: 1,
      message: { messageId: 1, date: 0, text: 'x', chat: { id: 42, type: 'group' } },
    });
    expect(ev!.userId).toBe('42');
  });
});

describe('TelegramSurface — send()', () => {
  it('sends HTML-formatted text with citations', async () => {
    const captures: TelegramOutboundMessage[] = [];
    const s = new TelegramSurface({ client: mockClient(captures), tenantId: 'T' });
    const ev = s.normalize({
      updateId: 1,
      message: {
        messageId: 1,
        date: 0,
        text: 'q',
        chat: { id: 99, type: 'private' },
        from: { id: 1 },
      },
    })!;
    await s.send({
      event: ev,
      reply: {
        text: 'Hi <b>',
        citations: [{ sourceId: 'https://example.com', quote: 'verbatim' }],
      },
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]!.chatId).toBe('99');
    expect(captures[0]!.parseMode).toBe('HTML');
    expect(captures[0]!.text).toContain('Hi &lt;b&gt;');
    expect(captures[0]!.text).toContain('<b>Sources:</b>');
  });

  it('invokes rate-limit gate before sending', async () => {
    const order: string[] = [];
    const captures: TelegramOutboundMessage[] = [];
    const rate: RateLimitGate = {
      async schedule() {
        order.push('rate');
      },
    };
    const client: TelegramClient = {
      async sendMessage(m) {
        order.push('send');
        captures.push(m);
        return { messageId: 1 };
      },
    };
    const s = new TelegramSurface({ client, rateLimit: rate, tenantId: 'T' });
    const ev = s.normalize({
      updateId: 1,
      message: { messageId: 1, date: 0, text: 'x', chat: { id: 1, type: 'p' }, from: { id: 1 } },
    })!;
    await s.send({ event: ev, reply: { text: 'ok', citations: [] } });
    expect(order).toEqual(['rate', 'send']);
  });
});
