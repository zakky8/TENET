import type { ChatModel, ClaimVerdict, VerifierConfig } from './types.js';
import { responseText, textMessage } from '@tenet/core';
import { withTimeoutAndSignal } from './timeout.js';

/**
 * Pre-pass: a claim auto-passes ONLY when every URL-shaped token it contains
 * matches an allowlisted host (or host + path prefix).
 *
 * Previous implementation used `claim.toLowerCase().includes(pattern)` which
 * was vulnerable to:
 *   - lookalike domains: `notexample.com` substring-matches `example.com`
 *   - phishing siblings: `docs.example-mirror.io` matches `docs.example.com`
 *     when pattern was `example.com` — actually doesn't here, but partial
 *     URL substrings still slip through (e.g. pattern `http` would match
 *     every URL).
 *
 * New rules:
 *   1. Extract URL-shaped tokens via regex.
 *   2. Normalize each (strip scheme, strip leading www., lowercase).
 *   3. Normalize each pattern the same way.
 *   4. Match by exact equality OR allowed-is-prefix-with-trailing-slash.
 *   5. Claim only auto-passes when AT LEAST ONE URL is present AND
 *      EVERY extracted URL matches the allowlist.
 */
const URL_RE = /\b(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)((?:\/[^\s)\]"']*)?)/gi;

function normalizeUrlForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

export function isClaimAboutAllowedUrl(
  claim: string,
  allowedUrlPatterns: ReadonlyArray<string>,
): boolean {
  if (allowedUrlPatterns.length === 0) return false;

  const matches = Array.from(claim.matchAll(URL_RE));
  if (matches.length === 0) return false;

  const allowedNormalized = allowedUrlPatterns.map(normalizeUrlForMatch);

  const extracted = matches.map((m) => {
    const host = (m[1] ?? '').toLowerCase().replace(/^www\./, '');
    const path = m[2] ?? '';
    return host + path.replace(/\/+$/, '');
  });

  return extracted.every((url) =>
    allowedNormalized.some(
      (allowed) => url === allowed || url.startsWith(allowed + '/'),
    ),
  );
}

import { effectiveDecorators } from './strategies.js';

function buildSystem(
  permissive: boolean,
  config: VerifierConfig,
): string {
  const judgePolicy = permissive
    ? `You are a PERMISSIVE fact judge. Mark a claim as SUPPORTED if the SOURCES contain the same information even with different wording, paraphrasing, or rearrangement. Only mark UNSUPPORTED if the SOURCES truly do NOT contain the claim's information.`
    : `You are a STRICT fact judge. Mark a claim as SUPPORTED only if the SOURCES explicitly contain the same information. Vague matches are NOT enough. Numbers, dates, and names must match exactly.`;

  // Decorators run on strict policy only; permissive policy stays minimal.
  let policyWithDecorators = judgePolicy;
  if (!permissive) {
    for (const d of effectiveDecorators(config)) {
      policyWithDecorators = d.appendToStrictPolicy(policyWithDecorators);
    }
  }

  return `${policyWithDecorators}

OUTPUT FORMAT (one line per claim, in input order, exact format):
[N] SUPPORTED
or
[N] UNSUPPORTED: <one short phrase explaining what's missing>

Do not add commentary. Do not skip any claim. Do not output blank lines.`;
}

const PARSE_LINE_RE = /^\[?(\d+)\]?\s*(SUPPORTED|UNSUPPORTED)\s*:?\s*(.*)$/i;

/** Run a single judge call against one batch of claims. Fail-open on error. */
export async function judgeOneBatch(
  model: ChatModel,
  sources: string,
  claims: string[],
  permissive: boolean,
  config: VerifierConfig,
): Promise<ClaimVerdict[]> {
  if (claims.length === 0) return [];
  const numbered = claims.map((c, i) => `[${i + 1}] ${c}`).join('\n');
  const system = buildSystem(permissive, config);

  let raw: string;
  try {
    raw = responseText(
      await withTimeoutAndSignal(
        (signal) =>
          model.chat({
            system,
            messages: [textMessage('user', `SOURCES:\n${sources}\n\nCLAIMS:\n${numbered}`)],
            maxTokens: 256,
            signal,
          }),
        config.judgeTimeoutMs,
        'judge',
      ),
    );
  } catch {
    // Judge model down/timeout. Default fail-OPEN (supported) so we don't block shipping;
    // under failClosed, mark all NOT-supported — a judge we couldn't run cannot clear a claim.
    return claims.map((claim) => ({
      claim,
      supported: !config.failClosed,
      reason: config.failClosed ? 'judge unavailable (fail-closed)' : '',
    }));
  }

  const verdictByIdx = new Map<number, ClaimVerdict>();
  for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(PARSE_LINE_RE);
    if (!m) continue;
    const n = parseInt(m[1]!, 10);
    if (Number.isNaN(n) || n < 1 || n > claims.length) continue;
    const supported = /^SUPPORTED$/i.test(m[2]!);
    verdictByIdx.set(n, {
      claim: claims[n - 1]!,
      supported,
      reason: supported ? '' : (m[3] || '').trim().slice(0, 120),
    });
  }

  // Differential fallback for unparsed verdicts:
  //   - If SOME lines parsed but this index is missing → judge spoke but
  //     skipped this claim. Default UNSUPPORTED (fail-CLOSED): don't ship
  //     fabrication just because the judge forgot a line.
  //   - If NO lines parsed at all → judge response was total garbage / down.
  //     Default fail-OPEN (supported); under failClosed, NOT-supported (garbage from the
  //     judge cannot clear a claim).
  const parsedAny = verdictByIdx.size > 0;
  return claims.map((claim, i) => {
    const v = verdictByIdx.get(i + 1);
    if (v) return v;
    if (parsedAny) return { claim, supported: false, reason: 'no verdict from judge' };
    return {
      claim,
      supported: !config.failClosed,
      reason: config.failClosed ? 'judge response unparseable (fail-closed)' : '',
    };
  });
}

/** Run judging in bounded-parallel batches. */
export async function judgeBatched(
  model: ChatModel,
  sources: string,
  claims: string[],
  permissive: boolean,
  config: VerifierConfig,
): Promise<ClaimVerdict[]> {
  if (claims.length === 0) return [];

  const batches: string[][] = [];
  for (let i = 0; i < claims.length; i += config.claimsPerBatch) {
    batches.push(claims.slice(i, i + config.claimsPerBatch));
  }

  const results: ClaimVerdict[][] = new Array(batches.length);
  let next = 0;
  const workerCount = Math.min(config.maxParallelBatches, batches.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= batches.length) return;
        results[idx] = await judgeOneBatch(
          model,
          sources,
          batches[idx]!,
          permissive,
          config,
        );
      }
    }),
  );

  return results.flat();
}
