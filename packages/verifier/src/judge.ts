import type { ChatModel, ClaimVerdict, VerifierConfig } from './types.js';

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

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    });
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildSystem(
  permissive: boolean,
  adversarialExamples: string | undefined,
): string {
  const judgePolicy = permissive
    ? `You are a PERMISSIVE fact judge. Mark a claim as SUPPORTED if the SOURCES contain the same information even with different wording, paraphrasing, or rearrangement. Only mark UNSUPPORTED if the SOURCES truly do NOT contain the claim's information.`
    : `You are a STRICT fact judge. Mark a claim as SUPPORTED only if the SOURCES explicitly contain the same information. Vague matches are NOT enough. Numbers, dates, and names must match exactly.`;

  const examples = permissive ? '' : adversarialExamples ?? '';

  return `${judgePolicy}${examples}

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
  const system = buildSystem(permissive, config.adversarialExamples);

  let raw: string;
  try {
    raw = await withTimeout(
      model.chat({
        system,
        user: `SOURCES:\n${sources}\n\nCLAIMS:\n${numbered}`,
        maxTokens: 256,
      }),
      config.judgeTimeoutMs,
      'judge',
    );
  } catch {
    // fail-open — mark all supported so we don't block shipping on judge breakage
    return claims.map((claim) => ({ claim, supported: true, reason: '' }));
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
  //     Fail-OPEN (supported) to avoid blocking shipping on judge breakage.
  const parsedAny = verdictByIdx.size > 0;
  return claims.map((claim, i) => {
    const v = verdictByIdx.get(i + 1);
    if (v) return v;
    return {
      claim,
      supported: !parsedAny,
      reason: parsedAny ? 'no verdict from judge' : '',
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
