import type {
  ConversationMessage,
  NormalizedEvent,
  Outcome,
  Source,
} from '@tenet/core';
import {
  CommunityBot,
  type BotChatModel,
  type BotMemory,
  type BotRetriever,
  type BotTelemetry,
  type BotVerifier,
} from './index.js';

// ── Doubles ───────────────────────────────────────────────────────────

function fakeRetriever(sources: Source[]): BotRetriever {
  return { async query() { return sources; } };
}
function fakeModel(reply: string, fail = false): BotChatModel {
  return {
    async chat() {
      if (fail) throw new Error('model down');
      return reply;
    },
  };
}
function fakeVerifier(pass: boolean, critique = ''): BotVerifier {
  return { async verify() { return { pass, critique }; } };
}
function fakeMemory(): BotMemory & { all: ConversationMessage[] } {
  const all: ConversationMessage[] = [];
  return {
    all,
    append(m) {
      all.push(m);
    },
    messages() {
      return all;
    },
  };
}
function fakeTelemetry(): BotTelemetry & { events: Array<{ outcome: Outcome; reason?: string }> } {
  const events: Array<{ outcome: Outcome; reason?: string }> = [];
  return {
    events,
    record(e) {
      events.push({ outcome: e.outcome, ...(e.reason ? { reason: e.reason } : {}) });
    },
  };
}

const EV: NormalizedEvent = {
  surface: 'telegram',
  tenantId: 'T',
  conversationId: 'C',
  userId: 'U',
  text: 'What is the answer?',
  receivedAt: 1000,
};

const SRC = (id: string, text: string): Source => ({
  id,
  uri: `https://example.com/${id}`,
  text,
  confidence: 0.9,
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('CommunityBot — construction', () => {
  it('requires systemPrompt', () => {
    expect(
      () =>
        new CommunityBot({
          retriever: fakeRetriever([]),
          model: fakeModel('x'),
          verifier: fakeVerifier(true),
          memory: fakeMemory(),
          systemPrompt: '',
        }),
    ).toThrow();
  });
});

describe('CommunityBot — happy path', () => {
  it('returns the model draft as text + citations from retrieved sources, records resolved', async () => {
    const sources = [SRC('s1', 'the answer is 42')];
    const mem = fakeMemory();
    const tel = fakeTelemetry();
    const bot = new CommunityBot({
      retriever: fakeRetriever(sources),
      model: fakeModel('Answer: 42'),
      verifier: fakeVerifier(true),
      memory: mem,
      telemetry: tel,
      systemPrompt: 'You are TENET.',
    });
    const reply = await bot.handle(EV);
    expect(reply.text).toBe('Answer: 42');
    expect(reply.citations).toHaveLength(1);
    expect(reply.citations[0]?.sourceId).toBe('s1');
    expect(mem.all.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(tel.events[0]?.outcome).toBe('resolved');
  });
});

describe('CommunityBot — verifier rejection', () => {
  it('returns abstain reply and records disqualified', async () => {
    const mem = fakeMemory();
    const tel = fakeTelemetry();
    const bot = new CommunityBot({
      retriever: fakeRetriever([SRC('s', 't')]),
      model: fakeModel('hallucinated text'),
      verifier: fakeVerifier(false, 'unsupported claim'),
      memory: mem,
      telemetry: tel,
      systemPrompt: 'sys',
    });
    const reply = await bot.handle(EV);
    expect(reply.text).toMatch(/don't have a confirmed/i);
    expect(reply.citations).toEqual([]);
    // Assistant message NOT appended on disqualified
    expect(mem.all.map((m) => m.role)).toEqual(['user']);
    expect(tel.events[0]?.outcome).toBe('disqualified');
  });
});

describe('CommunityBot — model error', () => {
  it('returns abstain, records disqualified, NO assistant message appended', async () => {
    const mem = fakeMemory();
    const tel = fakeTelemetry();
    const bot = new CommunityBot({
      retriever: fakeRetriever([]),
      model: fakeModel('x', /*fail=*/ true),
      verifier: fakeVerifier(true),
      memory: mem,
      telemetry: tel,
      systemPrompt: 'sys',
    });
    const reply = await bot.handle(EV);
    expect(reply.text).toMatch(/don't have/i);
    expect(mem.all.map((m) => m.role)).toEqual(['user']);
    expect(tel.events[0]?.outcome).toBe('disqualified');
    expect(tel.events[0]?.reason).toMatch(/model error/);
  });
});

describe('CommunityBot — telemetry optional', () => {
  it('works without a telemetry sink', async () => {
    const bot = new CommunityBot({
      retriever: fakeRetriever([]),
      model: fakeModel('ok'),
      verifier: fakeVerifier(true),
      memory: fakeMemory(),
      systemPrompt: 'sys',
    });
    await expect(bot.handle(EV)).resolves.toBeDefined();
  });
});
