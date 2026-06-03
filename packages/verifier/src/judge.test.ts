import { isClaimAboutAllowedUrl, judgeBatched, judgeOneBatch } from './judge.js';
import { DEFAULT_VERIFIER_CONFIG, type ChatModel } from './types.js';

describe('isClaimAboutAllowedUrl', () => {
  const PATTERNS = ['discord.gg/abc', 'example.com', 'github.com/foo'];

  it('returns true when claim contains an allowlisted URL', () => {
    expect(isClaimAboutAllowedUrl('Join discord.gg/abc for support.', PATTERNS)).toBe(true);
    expect(isClaimAboutAllowedUrl('See example.com', PATTERNS)).toBe(true);
  });

  it('returns false when no allowlisted URL is present', () => {
    expect(isClaimAboutAllowedUrl('Bitcoin is digital gold.', PATTERNS)).toBe(false);
    expect(isClaimAboutAllowedUrl('Visit phishing.example/foo', PATTERNS)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isClaimAboutAllowedUrl('See EXAMPLE.COM', PATTERNS)).toBe(true);
    expect(isClaimAboutAllowedUrl('see Discord.GG/abc', PATTERNS)).toBe(true);
  });

  it('returns false when allowed list is empty', () => {
    expect(isClaimAboutAllowedUrl('discord.gg/abc', [])).toBe(false);
  });

  it('host+path prefix-matches — claim with subpath of allowed path still matches', () => {
    // 'github.com/foo' as allowlist allows subpaths like /foo/sub/page
    expect(isClaimAboutAllowedUrl('github.com/foo/sub/page', PATTERNS)).toBe(true);
  });

  // ── FIX #1 — substring-match URL bypass regressions ──────────────────────

  it('REGRESSION: lookalike host "notexample.com" does NOT match allowlisted "example.com"', () => {
    expect(isClaimAboutAllowedUrl('Visit notexample.com/login for your refund', PATTERNS)).toBe(false);
  });

  it('REGRESSION: phishing mirror "docs.example-mirror.io" does NOT match "example.com"', () => {
    expect(isClaimAboutAllowedUrl('docs.example-mirror.io is deprecated', PATTERNS)).toBe(false);
  });

  it('REGRESSION: broad pattern "http" never causes auto-pass (must be a real host)', () => {
    // If an operator misconfigures allowlist with 'http', it should not
    // match the substring 'http' in arbitrary claims. The URL extractor
    // requires a host with at least one dot, so 'http' alone matches no URL.
    expect(isClaimAboutAllowedUrl('Our policy at http://internal-server', ['http'])).toBe(false);
  });

  it('REGRESSION: extra suffix after host does NOT auto-pass — "example.com.attacker.net" is its own host', () => {
    expect(isClaimAboutAllowedUrl('See example.com.attacker.net for details', PATTERNS)).toBe(false);
  });

  it('claim with no URLs returns false (was a bug: empty-URL extraction != "all match")', () => {
    expect(isClaimAboutAllowedUrl('Bitcoin is digital gold.', PATTERNS)).toBe(false);
  });

  it('claim with ONE allowed + ONE foreign URL does NOT auto-pass (every() semantics)', () => {
    // Mixed URLs — judge must still see this
    expect(isClaimAboutAllowedUrl(
      'Visit example.com but avoid evil.io',
      PATTERNS,
    )).toBe(false);
  });

  it('scheme + www. + trailing slash variants all normalize equivalently', () => {
    expect(isClaimAboutAllowedUrl('See https://www.example.com/', PATTERNS)).toBe(true);
    expect(isClaimAboutAllowedUrl('See http://example.com', PATTERNS)).toBe(true);
    expect(isClaimAboutAllowedUrl('See www.example.com', PATTERNS)).toBe(true);
  });
});

function mockModel(reply: string): ChatModel {
  return { chat: async () => reply };
}
function slowModel(reply: string, delayMs: number): ChatModel {
  return {
    chat: () =>
      new Promise((res) => setTimeout(() => res(reply), delayMs)),
  };
}
function brokenModel(): ChatModel {
  return { chat: async () => { throw new Error('upstream'); } };
}

describe('judgeOneBatch', () => {
  it('parses [1] SUPPORTED / [2] UNSUPPORTED correctly', async () => {
    const model = mockModel('[1] SUPPORTED\n[2] UNSUPPORTED: number mismatch');
    const out = await judgeOneBatch(
      model,
      'sources',
      ['claim A', 'claim B'],
      false,
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out).toEqual([
      { claim: 'claim A', supported: true, reason: '' },
      { claim: 'claim B', supported: false, reason: 'number mismatch' },
    ]);
  });

  it('handles unbracketed format "1 SUPPORTED"', async () => {
    const model = mockModel('1 SUPPORTED\n2 SUPPORTED');
    const out = await judgeOneBatch(
      model,
      'sources',
      ['a', 'b'],
      false,
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out.every((v) => v.supported)).toBe(true);
  });

  it('fails open on judge timeout — marks all supported', async () => {
    const model = slowModel('[1] UNSUPPORTED: x', 10_000);
    const out = await judgeOneBatch(
      model,
      'sources',
      ['c'],
      false,
      { ...DEFAULT_VERIFIER_CONFIG, judgeTimeoutMs: 30 },
    );
    expect(out).toEqual([{ claim: 'c', supported: true, reason: '' }]);
  });

  it('fails open when model throws', async () => {
    const out = await judgeOneBatch(
      brokenModel(),
      'sources',
      ['x', 'y'],
      false,
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out.every((v) => v.supported)).toBe(true);
  });

  it('partial-parse: missing indices default to UNSUPPORTED when SOME lines parsed (fail-closed)', async () => {
    // Model returned verdict for #1, skipped #2 + #3.
    // Behavior change post-fix: the judge SPOKE (1 line parsed), so missing
    // verdicts are treated as "judge skipped this" not "judge broken".
    const model = mockModel('[1] UNSUPPORTED: bad');
    const out = await judgeOneBatch(
      model,
      'sources',
      ['x', 'y', 'z'],
      false,
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out[0]!.supported).toBe(false);
    expect(out[1]!.supported).toBe(false);
    expect(out[1]!.reason).toBe('no verdict from judge');
    expect(out[2]!.supported).toBe(false);
  });

  it('total-garbage: all-zero-lines-parsed falls back to supported (fail-open on judge breakage)', async () => {
    const model = mockModel('the model is having a stroke and emitting prose');
    const out = await judgeOneBatch(
      model,
      'sources',
      ['x', 'y'],
      false,
      DEFAULT_VERIFIER_CONFIG,
    );
    // Zero verdicts parsed → fail-open per design (don't block shipping)
    expect(out[0]!.supported).toBe(true);
    expect(out[1]!.supported).toBe(true);
  });

  it('rejects out-of-range indices ([99] SUPPORTED with 2 claims)', async () => {
    const model = mockModel('[99] SUPPORTED\n[1] UNSUPPORTED: x');
    const out = await judgeOneBatch(
      model,
      'sources',
      ['a', 'b'],
      false,
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out[0]!.supported).toBe(false);
    // Post-fix: #2 missing while #1 was parsed → fail-closed
    expect(out[1]!.supported).toBe(false);
  });

  it('truncates long reasons to 120 chars (prevents prompt-injection bloat)', async () => {
    const longReason = 'x'.repeat(500);
    const model = mockModel(`[1] UNSUPPORTED: ${longReason}`);
    const out = await judgeOneBatch(
      model,
      'sources',
      ['claim'],
      false,
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out[0]!.reason.length).toBeLessThanOrEqual(120);
  });

  it('returns [] for empty claims input', async () => {
    const out = await judgeOneBatch(
      mockModel(''),
      'sources',
      [],
      false,
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out).toEqual([]);
  });

  it('permissive mode does NOT inject adversarial examples', async () => {
    let capturedSystem = '';
    const model: ChatModel = {
      chat: async ({ system }) => {
        capturedSystem = system;
        return '[1] SUPPORTED';
      },
    };
    await judgeOneBatch(model, 'srcs', ['x'], true, {
      ...DEFAULT_VERIFIER_CONFIG,
      adversarialExamples: '\n\nEXAMPLES: trap pattern X\n',
    });
    expect(capturedSystem).not.toContain('trap pattern X');
    expect(capturedSystem).toContain('PERMISSIVE');
  });

  it('strict mode DOES inject adversarial examples', async () => {
    let capturedSystem = '';
    const model: ChatModel = {
      chat: async ({ system }) => {
        capturedSystem = system;
        return '[1] SUPPORTED';
      },
    };
    await judgeOneBatch(model, 'srcs', ['x'], false, {
      ...DEFAULT_VERIFIER_CONFIG,
      adversarialExamples: '\n\nEXAMPLES: trap pattern X\n',
    });
    expect(capturedSystem).toContain('trap pattern X');
    expect(capturedSystem).toContain('STRICT');
  });
});

describe('judgeBatched', () => {
  it('processes claims in batches of claimsPerBatch', async () => {
    let calls = 0;
    const model: ChatModel = {
      chat: async ({ user }) => {
        calls++;
        // Echo back SUPPORTED for every numbered claim in the user payload
        const claimLines = user.split('CLAIMS:\n')[1] ?? '';
        const ns = (claimLines.match(/\[(\d+)\]/g) ?? []).map((m) =>
          parseInt(m.replace(/[[\]]/g, ''), 10),
        );
        return ns.map((n) => `[${n}] SUPPORTED`).join('\n');
      },
    };
    const out = await judgeBatched(model, 'src', ['a', 'b', 'c', 'd', 'e'], false, {
      ...DEFAULT_VERIFIER_CONFIG,
      claimsPerBatch: 2,
    });
    expect(calls).toBe(3); // 5 claims / 2 = 3 batches
    expect(out).toHaveLength(5);
    expect(out.every((v) => v.supported)).toBe(true);
  });

  it('preserves claim order across batches', async () => {
    const model: ChatModel = {
      chat: async ({ user }) => {
        const claims = (user.split('CLAIMS:\n')[1] ?? '').split('\n').filter(Boolean);
        return claims
          .map((line, i) => {
            const isFirstClaimInBatch = line.includes('[1]');
            return isFirstClaimInBatch ? `[${i + 1}] UNSUPPORTED: x` : `[${i + 1}] SUPPORTED`;
          })
          .join('\n');
      },
    };
    const out = await judgeBatched(model, 'src', ['c1', 'c2', 'c3', 'c4'], false, {
      ...DEFAULT_VERIFIER_CONFIG,
      claimsPerBatch: 2,
    });
    expect(out.map((v) => v.claim)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('returns [] on empty input', async () => {
    const out = await judgeBatched(
      mockModel(''),
      'src',
      [],
      false,
      DEFAULT_VERIFIER_CONFIG,
    );
    expect(out).toEqual([]);
  });

  it('respects maxParallelBatches concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const model: ChatModel = {
      chat: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return '[1] SUPPORTED\n[2] SUPPORTED';
      },
    };
    // 10 claims / 2 per batch = 5 batches; cap to 2 parallel
    await judgeBatched(model, 'src', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], false, {
      ...DEFAULT_VERIFIER_CONFIG,
      claimsPerBatch: 2,
      maxParallelBatches: 2,
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
