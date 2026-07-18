/**
 * Deterministic tests for the fail-closed Reasoner (increment 2.2a).
 *
 * No real model access exists at build time — every test drives modelReasoner
 * with a FAKE ChatModel returning a canned ChatResponse. That is the point:
 * the anti-hallucination guarantee is enforced by the deterministic
 * ChatResponse → ReasonerOutput mapping, so it is provable without a model.
 * Each test is written to FAIL if the fail-closed rule it covers were broken
 * (e.g. if an uncited answer shipped as `kind: 'answer'`).
 */
import type { ChatModel, ChatRequest, ChatResponse } from '@tenet/core';
import { systemPromptLeakFilter } from '@tenet/guardrails';
import type { OrchestratorState } from './types.js';
import { buildSystem, modelReasoner, parseEnvelope } from './reasoner.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    event: {
      surface: 'test',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      userId: 'user-1',
      text: 'What is the daily drawdown limit?',
      receivedAt: 0,
    },
    history: [{ role: 'user', content: 'What is the daily drawdown limit?' }],
    intent: 'question',
    sources: [],
    attempts: 0,
    ...overrides,
  };
}

/** Fake model: records the request, returns the canned response. */
function fakeModel(res: ChatResponse): ChatModel & { lastRequest: ChatRequest | undefined } {
  const model = {
    lastRequest: undefined as ChatRequest | undefined,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      model.lastRequest = req;
      return res;
    },
  };
  return model;
}

function textResponse(text: string): ChatResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

const signal = new AbortController().signal;

const VALID_ANSWER = {
  action: 'answer',
  text: 'The daily drawdown limit is 5% of starting balance.',
  citations: [{ sourceId: 'src-1', quote: 'daily drawdown is 5% of starting balance' }],
};

// ── modelReasoner: envelope (text) path ─────────────────────────────────────

describe('modelReasoner — envelope path', () => {
  it('valid answer envelope (text + 1 citation) -> kind answer with draft and citations', async () => {
    const reasoner = modelReasoner(fakeModel(textResponse(JSON.stringify(VALID_ANSWER))), []);
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({
      kind: 'answer',
      draft: 'The daily drawdown limit is 5% of starting balance.',
      citations: [{ sourceId: 'src-1', quote: 'daily drawdown is 5% of starting balance' }],
    });
  });

  it('answer envelope with NO citations field -> abstain (uncited answer must not ship)', async () => {
    const reasoner = modelReasoner(
      fakeModel(textResponse(JSON.stringify({ action: 'answer', text: 'The limit is 5%.' }))),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'answer without a grounded citation' });
  });

  it('answer envelope with EMPTY citations array -> abstain', async () => {
    const reasoner = modelReasoner(
      fakeModel(
        textResponse(JSON.stringify({ action: 'answer', text: 'The limit is 5%.', citations: [] })),
      ),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'answer without a grounded citation' });
  });

  it('answer envelope with empty text -> abstain', async () => {
    const reasoner = modelReasoner(
      fakeModel(
        textResponse(
          JSON.stringify({
            action: 'answer',
            text: '',
            citations: [{ sourceId: 'src-1', quote: 'a quote' }],
          }),
        ),
      ),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'answer without a grounded citation' });
  });

  it('answer envelope with a WHITESPACE-ONLY citation quote -> abstain (blank citation must not satisfy the gate)', async () => {
    const reasoner = modelReasoner(
      fakeModel(
        textResponse(
          JSON.stringify({
            action: 'answer',
            text: 'The limit is 5%.',
            citations: [{ sourceId: 'src-1', quote: '   ' }],
          }),
        ),
      ),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    // Without the `.trim()` gate this whitespace-only quote would ship as a grounded answer.
    expect(out).toEqual({ kind: 'abstain', reason: 'answer without a grounded citation' });
  });

  it('answer envelope wrapped in ```json fences and prose -> still parsed to answer', async () => {
    const wrapped = [
      'Sure — here is my decision:',
      '```json',
      JSON.stringify({
        action: 'answer',
        text: 'The limit is 5%.',
        // Braces inside the quote must not confuse the extractor.
        citations: [{ sourceId: 'src-1', quote: 'limit {5%} applies } daily' }],
      }),
      '```',
      'Let me know if you need anything else.',
    ].join('\n');
    const reasoner = modelReasoner(fakeModel(textResponse(wrapped)), []);
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({
      kind: 'answer',
      draft: 'The limit is 5%.',
      citations: [{ sourceId: 'src-1', quote: 'limit {5%} applies } daily' }],
    });
  });

  it('completely malformed / non-JSON text -> abstain', async () => {
    const reasoner = modelReasoner(
      fakeModel(textResponse('The daily drawdown limit is 5%, hope that helps!')),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'unparseable reasoner envelope' });
  });

  it('unknown action ("foo") -> abstain', async () => {
    const reasoner = modelReasoner(
      fakeModel(textResponse(JSON.stringify({ action: 'foo', text: 'The limit is 5%.' }))),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'unknown reasoner action' });
  });

  it('missing action field -> abstain', async () => {
    const reasoner = modelReasoner(
      fakeModel(
        textResponse(
          JSON.stringify({ text: 'The limit is 5%.', citations: [{ sourceId: 's', quote: 'q' }] }),
        ),
      ),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'unknown reasoner action' });
  });

  it('valid handoff envelope -> kind handoff with target and reason', async () => {
    const reasoner = modelReasoner(
      fakeModel(
        textResponse(
          JSON.stringify({ action: 'handoff', target: 'billing-team', reason: 'refund request' }),
        ),
      ),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({
      kind: 'handoff',
      handoff: { kind: 'handoff', target: 'billing-team', reason: 'refund request' },
    });
  });

  it('handoff missing target -> abstain', async () => {
    const reasoner = modelReasoner(
      fakeModel(textResponse(JSON.stringify({ action: 'handoff', reason: 'needs a human' }))),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'handoff without a target' });
  });

  it('abstain envelope -> kind abstain with the model-provided reason', async () => {
    const reasoner = modelReasoner(
      fakeModel(textResponse(JSON.stringify({ action: 'abstain', reason: 'not in knowledge' }))),
      [],
    );
    const out = await reasoner.reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'not in knowledge' });
  });
});

// ── modelReasoner: stopReason paths ─────────────────────────────────────────

describe('modelReasoner — stopReason paths', () => {
  it("stopReason 'tool_use' with a tool_use block -> kind tool with {id,name,input} calls", async () => {
    const res: ChatResponse = {
      content: [
        { type: 'text', text: 'calling a tool' },
        { type: 'tool_use', id: 'tu-1', name: 'kb_lookup', input: { query: 'drawdown' } },
      ],
      stopReason: 'tool_use',
    };
    const out = await modelReasoner(fakeModel(res), []).reason(makeState(), signal);
    expect(out).toEqual({
      kind: 'tool',
      calls: [{ id: 'tu-1', name: 'kb_lookup', input: { query: 'drawdown' } }],
    });
  });

  it("stopReason 'tool_use' with NO tool_use blocks -> abstain (FAIL CLOSED)", async () => {
    const res: ChatResponse = {
      content: [{ type: 'text', text: 'I will call a tool' }],
      stopReason: 'tool_use',
    };
    const out = await modelReasoner(fakeModel(res), []).reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'tool_use stop with no tool blocks' });
  });

  it("stopReason 'tool_use' with a tool block WINS over a valid answer envelope in the text -> tool, NOT answer", async () => {
    const res: ChatResponse = {
      content: [
        { type: 'text', text: JSON.stringify(VALID_ANSWER) },
        { type: 'tool_use', id: 'tu-9', name: 'kb_lookup', input: {} },
      ],
      stopReason: 'tool_use',
    };
    const out = await modelReasoner(fakeModel(res), []).reason(makeState(), signal);
    // stopReason is checked BEFORE the text envelope parse — a decoy answer in the text must not win.
    expect(out).toEqual({ kind: 'tool', calls: [{ id: 'tu-9', name: 'kb_lookup', input: {} }] });
  });

  it("stopReason 'refusal' -> abstain, even if the text is a valid answer envelope", async () => {
    const res: ChatResponse = {
      content: [{ type: 'text', text: JSON.stringify(VALID_ANSWER) }],
      stopReason: 'refusal',
    };
    const out = await modelReasoner(fakeModel(res), []).reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'model refusal' });
  });

  it("stopReason 'aborted' -> abstain", async () => {
    const res: ChatResponse = { content: [], stopReason: 'aborted' };
    const out = await modelReasoner(fakeModel(res), []).reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'model aborted' });
  });

  it("stopReason 'max_tokens' -> abstain, even with a VALID answer envelope (truncation must not ship)", async () => {
    // The response was cut off at the token limit; the draft/citations may be incomplete.
    // Without the max_tokens guard this valid-looking envelope would ship as an answer.
    const res: ChatResponse = {
      content: [{ type: 'text', text: JSON.stringify(VALID_ANSWER) }],
      stopReason: 'max_tokens',
    };
    const out = await modelReasoner(fakeModel(res), []).reason(makeState(), signal);
    expect(out).toEqual({ kind: 'abstain', reason: 'model max_tokens' });
  });
});

// ── modelReasoner: request shape ────────────────────────────────────────────

describe('modelReasoner — request shape', () => {
  it('sends structured history, maxTokens 1024, the signal, and omits tools when empty', async () => {
    const model = fakeModel(textResponse(JSON.stringify(VALID_ANSWER)));
    await modelReasoner(model, []).reason(makeState(), signal);
    const req = model.lastRequest;
    expect(req).toBeDefined();
    expect(req?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'What is the daily drawdown limit?' }] },
    ]);
    expect(req?.maxTokens).toBe(1024);
    expect(req?.signal).toBe(signal);
    expect(req && 'tools' in req).toBe(false); // exactOptionalPropertyTypes: absent, not undefined
  });

  it('offers tools when the tool list is non-empty', async () => {
    const model = fakeModel(textResponse(JSON.stringify(VALID_ANSWER)));
    const tools = [
      { name: 'kb_lookup', description: 'Search the KB', inputSchema: { type: 'object' } },
    ];
    await modelReasoner(model, tools).reason(makeState(), signal);
    expect(model.lastRequest?.tools).toEqual(tools);
  });
});

// ── parseEnvelope: direct fail-closed edges ─────────────────────────────────

describe('parseEnvelope — fail-closed edges', () => {
  it('empty string -> abstain', () => {
    expect(parseEnvelope('')).toEqual({ kind: 'abstain', reason: 'unparseable reasoner envelope' });
  });

  it('unbalanced JSON (open brace never closed) -> abstain', () => {
    expect(parseEnvelope('{"action":"answer","text":"x"')).toEqual({
      kind: 'abstain',
      reason: 'unparseable reasoner envelope',
    });
  });

  it('balanced braces but invalid JSON -> abstain', () => {
    expect(parseEnvelope('{action: answer}')).toEqual({
      kind: 'abstain',
      reason: 'unparseable reasoner envelope',
    });
  });

  it('non-string action (number) -> abstain', () => {
    expect(parseEnvelope(JSON.stringify({ action: 42, text: 'x' }))).toEqual({
      kind: 'abstain',
      reason: 'unknown reasoner action',
    });
  });

  it('citation missing quote -> abstain (partial grounding is not grounding)', () => {
    const env = { action: 'answer', text: 'x', citations: [{ sourceId: 'src-1' }] };
    expect(parseEnvelope(JSON.stringify(env))).toEqual({
      kind: 'abstain',
      reason: 'answer without a grounded citation',
    });
  });

  it('one malformed citation among valid ones -> abstain', () => {
    const env = {
      action: 'answer',
      text: 'x',
      citations: [{ sourceId: 'src-1', quote: 'q' }, { sourceId: 'src-2', quote: 7 }],
    };
    expect(parseEnvelope(JSON.stringify(env))).toEqual({
      kind: 'abstain',
      reason: 'answer without a grounded citation',
    });
  });

  it('citations not an array -> abstain', () => {
    const env = { action: 'answer', text: 'x', citations: { sourceId: 's', quote: 'q' } };
    expect(parseEnvelope(JSON.stringify(env))).toEqual({
      kind: 'abstain',
      reason: 'answer without a grounded citation',
    });
  });

  it('answer with whitespace-only text -> abstain', () => {
    const env = { action: 'answer', text: '   ', citations: [{ sourceId: 's', quote: 'q' }] };
    expect(parseEnvelope(JSON.stringify(env))).toEqual({
      kind: 'abstain',
      reason: 'answer without a grounded citation',
    });
  });

  it('abstain with no reason -> abstain with default reason', () => {
    expect(parseEnvelope(JSON.stringify({ action: 'abstain' }))).toEqual({
      kind: 'abstain',
      reason: 'reasoner abstained',
    });
  });

  it('handoff without a reason string -> handoff with default reason', () => {
    expect(parseEnvelope(JSON.stringify({ action: 'handoff', target: 'human' }))).toEqual({
      kind: 'handoff',
      handoff: { kind: 'handoff', target: 'human', reason: 'reasoner requested handoff' },
    });
  });

  it('citation location is carried through when present (and only then)', () => {
    const env = {
      action: 'answer',
      text: 'x',
      citations: [{ sourceId: 's', quote: 'q', location: 'FAQ §3.2' }],
    };
    const out = parseEnvelope(JSON.stringify(env));
    expect(out).toEqual({
      kind: 'answer',
      draft: 'x',
      citations: [{ sourceId: 's', quote: 'q', location: 'FAQ §3.2' }],
    });
  });
});

// ── buildSystem ─────────────────────────────────────────────────────────────

describe('buildSystem (FIRST-DRAFT prompt — structure only, efficacy unvalidated)', () => {
  it('lists retrieved chunks as [source.id] source.text', () => {
    const state = makeState({
      chunks: [
        {
          source: { id: 'src-1', uri: 'kb://1', text: 'Daily drawdown is 5%.', confidence: 0.9 },
          relevance: 0.8,
        },
        {
          source: { id: 'src-2', uri: 'kb://2', text: 'Payouts are biweekly.', confidence: 0.7 },
          relevance: 0.5,
        },
      ],
    });
    const sys = buildSystem(state);
    expect(sys).toContain('[src-1] Daily drawdown is 5%.');
    expect(sys).toContain('[src-2] Payouts are biweekly.');
    expect(sys).not.toContain('(no knowledge retrieved)');
  });

  it('marks an empty knowledge block explicitly', () => {
    expect(buildSystem(makeState())).toContain('(no knowledge retrieved)');
  });

  it('carries the exact envelope instruction the parser enforces', () => {
    expect(buildSystem(makeState())).toContain(
      '{"action":"answer|handoff|abstain","text":"...","citations":[{"sourceId":"...","quote":"..."}],"target":"...","reason":"..."}',
    );
  });

  it('its OWN output is caught by the default outbound leak filter (patterns match the REAL prompt)', () => {
    // Guards the class of bug where the leak filter's patterns drift from the actual
    // system prompt (they once matched neither buildSystem nor anything in TENET). A
    // full leak of the real prompt MUST be blocked; reddens if either side drifts.
    expect(systemPromptLeakFilter().inspect(buildSystem(makeState())).kind).toBe('block');
  });
});
