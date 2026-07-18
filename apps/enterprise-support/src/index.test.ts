import type { NormalizedEvent, NormalizedReply, Outcome } from '@tenet/core';
import {
  EnterpriseSupportApp,
  type SurfaceAdapter,
  type TicketingConnectorAdapter,
  type AgentRuntime,
  type TelemetrySink,
} from './index.js';

function fakeAgent(reply: string): AgentRuntime {
  return {
    async handle(event) {
      return { text: `${reply}:${event.text}`, citations: [] };
    },
  };
}

function fakeSurface(name: string, captures: Array<NormalizedReply> = []): SurfaceAdapter {
  return {
    name,
    async send({ reply }) {
      captures.push(reply);
    },
  };
}

function fakeConnector(vendor: string, captures: Array<{ conversationId: string; text: string }> = []): TicketingConnectorAdapter {
  return {
    vendor,
    async postReply({ conversationId, text }) {
      captures.push({ conversationId, text });
    },
  };
}

function fakeTelemetry(events: Array<{ outcome: Outcome; reason?: string }> = []): TelemetrySink {
  return {
    record(e) {
      events.push({ outcome: e.outcome, ...(e.reason !== undefined ? { reason: e.reason } : {}) });
    },
  };
}

const EV = (surface: string, extras: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  surface,
  tenantId: 'T',
  conversationId: 'C',
  userId: 'U',
  text: 'hello',
  receivedAt: 1000,
  ...extras,
});

describe('EnterpriseSupportApp — construction', () => {
  it('requires agent', () => {
    expect(() => new EnterpriseSupportApp({ agent: undefined as any, surfaces: [], connectors: [] })).toThrow();
  });

  it('inventory exposes registered surfaces + connectors', () => {
    const app = new EnterpriseSupportApp({
      agent: fakeAgent('r'),
      surfaces: [fakeSurface('telegram'), fakeSurface('slack')],
      connectors: [fakeConnector('zendesk'), fakeConnector('intercom')],
    });
    const inv = app.inventory();
    expect(inv.surfaces.sort()).toEqual(['slack', 'telegram']);
    expect(inv.connectors.sort()).toEqual(['intercom', 'zendesk']);
  });
});

describe('EnterpriseSupportApp — dispatch via surface', () => {
  it('routes to registered surface adapter', async () => {
    const replies: NormalizedReply[] = [];
    const surf = fakeSurface('slack', replies);
    const app = new EnterpriseSupportApp({
      agent: fakeAgent('echo'),
      surfaces: [surf],
      connectors: [],
    });
    const r = await app.dispatch(EV('slack', { text: 'world' }));
    expect(r.text).toBe('echo:world');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe('echo:world');
  });

  it('records resolved outcome on success', async () => {
    const events: Array<{ outcome: Outcome }> = [];
    const app = new EnterpriseSupportApp({
      agent: fakeAgent('r'),
      surfaces: [fakeSurface('telegram')],
      connectors: [],
      telemetry: fakeTelemetry(events),
    });
    await app.dispatch(EV('telegram'));
    expect(events[0]!.outcome).toBe('resolved');
  });
});

describe('EnterpriseSupportApp — dispatch via ticketing connector', () => {
  it('routes ticketing:<vendor> events to the matching connector.postReply', async () => {
    const replies: Array<{ conversationId: string; text: string }> = [];
    const app = new EnterpriseSupportApp({
      agent: fakeAgent('echo'),
      surfaces: [],
      connectors: [fakeConnector('zendesk', replies)],
    });
    await app.dispatch(EV('ticketing:zendesk', { text: 'urgent', conversationId: 'ticket-42' }));
    expect(replies).toEqual([{ conversationId: 'ticket-42', text: 'echo:urgent' }]);
  });

  it('records disqualified when no connector matches', async () => {
    const events: Array<{ outcome: Outcome; reason?: string }> = [];
    const app = new EnterpriseSupportApp({
      agent: fakeAgent('r'),
      surfaces: [],
      connectors: [],
      telemetry: fakeTelemetry(events),
    });
    await app.dispatch(EV('ticketing:unknown'));
    expect(events[0]!.outcome).toBe('disqualified');
    expect(events[0]!.reason).toMatch(/no connector/);
  });
});

describe('EnterpriseSupportApp — dispatch errors', () => {
  it('records disqualified when agent throws', async () => {
    const events: Array<{ outcome: Outcome; reason?: string }> = [];
    const failingAgent: AgentRuntime = {
      async handle() {
        throw new Error('downstream broken');
      },
    };
    const app = new EnterpriseSupportApp({
      agent: failingAgent,
      surfaces: [fakeSurface('telegram')],
      connectors: [],
      telemetry: fakeTelemetry(events),
    });
    const r = await app.dispatch(EV('telegram'));
    expect(r.text).toBe('');
    expect(events[0]!.outcome).toBe('disqualified');
    expect(events[0]!.reason).toMatch(/downstream broken/);
  });

  it('records disqualified when surface.send throws', async () => {
    const events: Array<{ outcome: Outcome; reason?: string }> = [];
    const brokenSurface: SurfaceAdapter = {
      name: 'telegram',
      async send() {
        throw new Error('surface down');
      },
    };
    const app = new EnterpriseSupportApp({
      agent: fakeAgent('r'),
      surfaces: [brokenSurface],
      connectors: [],
      telemetry: fakeTelemetry(events),
    });
    await app.dispatch(EV('telegram'));
    expect(events[0]!.outcome).toBe('disqualified');
  });

  it('records disqualified when surface name is unknown', async () => {
    const events: Array<{ outcome: Outcome; reason?: string }> = [];
    const app = new EnterpriseSupportApp({
      agent: fakeAgent('r'),
      surfaces: [],
      connectors: [],
      telemetry: fakeTelemetry(events),
    });
    await app.dispatch(EV('mystery-surface'));
    expect(events[0]!.outcome).toBe('disqualified');
  });
});

describe('EnterpriseSupportApp — honest outcome telemetry (verifierPassed + costUsd)', () => {
  type Rec = { outcome: Outcome; verifierPassed: boolean | null; costUsd: number };
  function capture(events: Rec[]): TelemetrySink {
    return {
      record(e) {
        events.push({ outcome: e.outcome, verifierPassed: e.verifierPassed, costUsd: e.costUsd });
      },
    };
  }
  // An agent whose reply carries a verifier-approved citation (grounded).
  const groundedAgent = (): AgentRuntime => ({
    async handle(event) {
      return { text: `answer:${event.text}`, citations: [{ sourceId: 's1', quote: 'q' }] };
    },
  });

  it('records verifierPassed=true ONLY when a grounded, cited answer is emitted', async () => {
    const events: Rec[] = [];
    const app = new EnterpriseSupportApp({
      agent: groundedAgent(), surfaces: [fakeSurface('slack')], connectors: [], telemetry: capture(events),
    });
    await app.dispatch(EV('slack'));
    expect(events[0]!.outcome).toBe('resolved');
    expect(events[0]!.verifierPassed).toBe(true);
  });

  it('records verifierPassed=false for an emitted-but-uncited reply — the old code FABRICATED true here', async () => {
    const events: Rec[] = [];
    // fakeAgent returns citations:[] → not a grounded, verified answer.
    const app = new EnterpriseSupportApp({
      agent: fakeAgent('r'), surfaces: [fakeSurface('slack')], connectors: [], telemetry: capture(events),
    });
    await app.dispatch(EV('slack'));
    expect(events[0]!.outcome).toBe('resolved');
    expect(events[0]!.verifierPassed).toBe(false);
  });

  it('records verifierPassed=null on a dispatch error (no reply emitted)', async () => {
    const events: Rec[] = [];
    const failing: AgentRuntime = { async handle() { throw new Error('boom'); } };
    const app = new EnterpriseSupportApp({
      agent: failing, surfaces: [fakeSurface('slack')], connectors: [], telemetry: capture(events),
    });
    await app.dispatch(EV('slack'));
    expect(events[0]!.outcome).toBe('disqualified');
    expect(events[0]!.verifierPassed).toBeNull();
  });

  it('sources costUsd from the injected meter — the old code hardcoded 0', async () => {
    const events: Rec[] = [];
    const app = new EnterpriseSupportApp({
      agent: groundedAgent(), surfaces: [fakeSurface('slack')], connectors: [], telemetry: capture(events),
      costMeter: { total: () => 0.0123 },
    });
    await app.dispatch(EV('slack'));
    expect(events[0]!.costUsd).toBeCloseTo(0.0123);
  });

  it('costUsd is 0 only when no meter is wired (unmetered, not a fabricated figure)', async () => {
    const events: Rec[] = [];
    const app = new EnterpriseSupportApp({
      agent: groundedAgent(), surfaces: [fakeSurface('slack')], connectors: [], telemetry: capture(events),
    });
    await app.dispatch(EV('slack'));
    expect(events[0]!.costUsd).toBe(0);
  });
});
