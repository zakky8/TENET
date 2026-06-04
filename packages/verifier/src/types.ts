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

export interface VerifierConfig {
  claimsPerBatch: number;
  maxParallelBatches: number;
  maxClaims: number;
  extractionTimeoutMs: number;
  judgeTimeoutMs: number;
  /** URLs the bot is allowed to emit — claims about these auto-pass. */
  allowedUrlPatterns: ReadonlyArray<string>;
  /** Adversarial worked examples appended to the strict-judge prompt. */
  adversarialExamples?: string;
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
