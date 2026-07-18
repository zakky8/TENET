import type { Citation } from '@tenet/core';
import { groundedRenderGate, hasGroundedCitation, type RenderableReply } from './index.js';

const cite = (sourceId: string, quote: string): Citation => ({ sourceId, quote });
const reply = (text: string, citations: Citation[] = []): RenderableReply => ({ text, citations });

const FALLBACK = "I can't back that up with a source, so I'd rather not guess.";

describe('hasGroundedCitation', () => {
  it('true only when a citation has BOTH a non-blank sourceId and quote', () => {
    expect(hasGroundedCitation([cite('s1', 'the policy says X')])).toBe(true);
    expect(hasGroundedCitation([])).toBe(false);
    expect(hasGroundedCitation([cite('', 'quote')])).toBe(false); // blank sourceId
    expect(hasGroundedCitation([cite('s1', '   ')])).toBe(false); // blank quote
    expect(hasGroundedCitation([cite('  ', '')])).toBe(false);
  });
});

describe('groundedRenderGate — renders a grounded answer as-is', () => {
  it('a fact-bearing reply with a grounded citation is rendered unchanged', () => {
    const r = reply('Refunds take 14 days.', [cite('kb-refund', 'refunds are processed within 14 days')]);
    const d = groundedRenderGate(r, { fallback: FALLBACK });
    expect(d.grounded).toBe(true);
    expect(d.text).toBe('Refunds take 14 days.');
    if (d.grounded) expect(d.citations).toHaveLength(1);
  });

  it('passes when at least one of several citations is grounded', () => {
    const r = reply('answer', [cite('', ''), cite('s2', 'backing quote')]);
    expect(groundedRenderGate(r, { fallback: FALLBACK }).grounded).toBe(true);
  });
});

describe('groundedRenderGate — REFUSES an ungrounded fact-bearing reply (the guarantee)', () => {
  it('fact-bearing text with NO citations → renders the safe fallback, not the text', () => {
    const r = reply('The CEO is Jane Doe and the price is $499.'); // no citations
    const d = groundedRenderGate(r, { fallback: FALLBACK });
    expect(d.grounded).toBe(false);
    expect(d.text).toBe(FALLBACK); // the ungrounded fact is NOT rendered
    expect(d.text).not.toContain('Jane Doe');
    if (!d.grounded) expect(d.reason).toMatch(/ungrounded/);
  });

  it('fact-bearing text with only BLANK citations → also refused', () => {
    const r = reply('some confident claim', [cite('', 'q'), cite('s', '')]);
    const d = groundedRenderGate(r, { fallback: FALLBACK });
    expect(d.grounded).toBe(false);
    expect(d.text).toBe(FALLBACK);
  });
});

describe('groundedRenderGate — empty reply carries no fact', () => {
  it('blank text passes through (nothing to leak), never substituted', () => {
    const d = groundedRenderGate(reply('   ', []), { fallback: FALLBACK });
    expect(d.grounded).toBe(false);
    expect(d.text).toBe('   '); // rendered as-is; it carries no fact
    if (!d.grounded) expect(d.reason).toMatch(/empty/);
  });
});
