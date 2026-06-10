import type { Citation, Source, SourcePicker } from '@tenet/core';

export interface ClaimVerdict {
  claim: string;
  supported: boolean;
  /** Short phrase explaining what's missing. Empty on PASS. */
  reason: string;
}

export interface VerifyResult {
  /** true → ship the draft as-is. false → loop back to generate with critique. */
  pass: boolean;
  /** One short sentence the generator must address on retry. */
  critique: string;
  /** Per-claim verdicts (telemetry / debug). */
  verdicts: ReadonlyArray<ClaimVerdict>;
  /** Citations the verifier approved for emission. */
  approvedCitations: ReadonlyArray<Citation>;
}

/**
 * Decide whether an individual claim can be trusted without judging.
 * The built-in URL allow-list filter is one impl; apps can plug others
 * (e.g. "claims that quote source code verbatim auto-pass", "claims
 * matching a known-good-fact KB auto-pass").
 */
export interface ClaimPreFilter {
  passesWithoutJudging(claim: string): boolean;
}

/**
 * Modify the strict-judge prompt. Adversarial worked examples are one
 * impl; apps can plug their own (domain-specific trap patterns,
 * jurisdiction-specific guardrails, etc.).
 */
export interface JudgePromptDecorator {
  appendToStrictPolicy(policy: string): string;
}

export interface VerifierConfig {
  claimsPerBatch: number;
  maxParallelBatches: number;
  maxClaims: number;
  extractionTimeoutMs: number;
  judgeTimeoutMs: number;
  /**
   * High-level convenience: URLs the bot is allowed to emit — claims
   * mentioning only these auto-pass. Internally wrapped into a
   * ClaimPreFilter (see urlAllowlistFilter()).
   */
  allowedUrlPatterns: ReadonlyArray<string>;
  /**
   * High-level convenience: adversarial worked examples appended to
   * the strict-judge prompt. Internally wrapped into a JudgePromptDecorator.
   */
  adversarialExamples?: string;
  /**
   * Low-level escape hatch: additional ClaimPreFilters evaluated BEFORE
   * the built-in URL allow-list. The first filter that returns true
   * short-circuits judging for that claim.
   */
  claimPreFilters?: ReadonlyArray<ClaimPreFilter>;
  /**
   * Low-level escape hatch: additional JudgePromptDecorators applied
   * BEFORE the adversarialExamples convenience. Use to inject
   * app-specific trap patterns.
   */
  judgePromptDecorators?: ReadonlyArray<JudgePromptDecorator>;
  /**
   * Deterministic pre-check tier (P16): three-way checks run BEFORE the
   * LLM judges. 'pass' trusts the claim without judging; 'fail' rejects
   * it with NO permissive rescue (hard fabrication evidence, e.g. a
   * number absent from every source); 'judge' defers to the LLM path.
   * Use defaultPreChecks() for quote-grounding + numeric-fabrication.
   * Default: none — opt-in, fully backwards compatible.
   */
  claimPreChecks?: ReadonlyArray<import('./deterministic.js').ClaimPreCheck>;
}

export const DEFAULT_VERIFIER_CONFIG: VerifierConfig = {
  claimsPerBatch: 2,
  maxParallelBatches: 5,
  maxClaims: 8,
  extractionTimeoutMs: 6000,
  judgeTimeoutMs: 5000,
  allowedUrlPatterns: [],
};

/** Adapter the verifier uses to call a language model. */
export interface ChatModel {
  /**
   * System + user → completion text. Throws on timeout/error.
   *
   * `signal` is the verifier's cancellation channel: when the verifier's
   * own timeout fires it calls AbortController.abort() to release the
   * in-flight HTTP request. Adapters MUST forward `signal` to their HTTP
   * client (fetch / AWS SDK / etc.) — otherwise zombie requests keep
   * billing and consuming rate-limit budget after the verifier has moved on.
   */
  chat(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface VerifyInput {
  /** Concatenated KNOWLEDGE block + retrieved source chunks the model saw. */
  sources: string;
  /** Structured source records (id-keyed). Used to attach citations on approval. */
  sourceRecords?: ReadonlyArray<Source>;
  /** The model's draft response to verify. */
  draft: string;
  /** Override the citation backing-source picker (default in defaultSourcePicker.ts). */
  sourcePicker?: SourcePicker;
}
