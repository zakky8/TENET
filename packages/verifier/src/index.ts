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
export const VERSION = '0.0.0';
