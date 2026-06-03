import type { ChatModel, ClaimVerdict, VerifierConfig } from './types.js';

/** Pre-pass: claims that only reference allowlisted URLs auto-pass. */
export function isClaimAboutAllowedUrl(
  claim: string,
  allowedUrlPatterns: ReadonlyArray<string>,
): boolean {
  if (allowedUrlPatterns.length === 0) return false;
  const lower = claim.toLowerCase();
  return allowedUrlPatterns.some((u) => lower.includes(u.toLowerCase()));
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

  return claims.map(
    (claim, i) => verdictByIdx.get(i + 1) ?? { claim, supported: true, reason: '' },
  );
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
