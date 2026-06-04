import { isClaimAboutAllowedUrl } from './judge.js';
import type { ClaimPreFilter, JudgePromptDecorator } from './types.js';

/**
 * Built-in ClaimPreFilter: claims whose URL-shaped tokens all match an
 * allow-list auto-pass without judging.
 */
export function urlAllowlistFilter(
  allowedUrlPatterns: ReadonlyArray<string>,
): ClaimPreFilter {
  return {
    passesWithoutJudging(claim: string): boolean {
      return isClaimAboutAllowedUrl(claim, allowedUrlPatterns);
    },
  };
}

/**
 * Built-in JudgePromptDecorator: appends a literal examples block to the
 * strict-policy section of the judge prompt. The block is appended VERBATIM
 * after a newline — apps own the format.
 */
export function examplesDecorator(examples: string): JudgePromptDecorator {
  return {
    appendToStrictPolicy(policy: string): string {
      return policy + (examples.startsWith('\n') ? examples : '\n' + examples);
    },
  };
}

/**
 * Compose the effective ClaimPreFilter list for a config. App-supplied
 * filters run first; the URL allow-list convenience runs last.
 */
export function effectivePreFilters(config: {
  claimPreFilters?: ReadonlyArray<ClaimPreFilter>;
  allowedUrlPatterns: ReadonlyArray<string>;
}): ReadonlyArray<ClaimPreFilter> {
  const out: ClaimPreFilter[] = [];
  if (config.claimPreFilters) out.push(...config.claimPreFilters);
  if (config.allowedUrlPatterns.length > 0) {
    out.push(urlAllowlistFilter(config.allowedUrlPatterns));
  }
  return out;
}

/**
 * Compose the effective JudgePromptDecorator list. App-supplied decorators
 * run first; the adversarial-examples convenience runs last.
 */
export function effectiveDecorators(config: {
  judgePromptDecorators?: ReadonlyArray<JudgePromptDecorator>;
  adversarialExamples?: string;
}): ReadonlyArray<JudgePromptDecorator> {
  const out: JudgePromptDecorator[] = [];
  if (config.judgePromptDecorators) out.push(...config.judgePromptDecorators);
  if (config.adversarialExamples) {
    out.push(examplesDecorator(config.adversarialExamples));
  }
  return out;
}
