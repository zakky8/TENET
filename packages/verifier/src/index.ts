export * from './types.js';
export * from './verifier.js';
export { isClaimAboutAllowedUrl, judgeOneBatch, judgeBatched } from './judge.js';
export { extractClaims } from './claimExtractor.js';
export { defaultSourcePicker } from './defaultSourcePicker.js';
export {
  urlAllowlistFilter,
  examplesDecorator,
  effectivePreFilters,
  effectiveDecorators,
} from './strategies.js';
export { STANDARD_ADVERSARIAL_EXAMPLES } from './standardAdversarialExamples.js';
export {
  defaultPreChecks,
  extractNumericValues,
  numericFabricationCheck,
  quoteGroundingCheck,
  runPreChecks,
  type ClaimPreCheck,
  type PreCheckResult,
  type PreCheckVerdict,
} from './deterministic.js';
export const VERSION = '0.0.0';
