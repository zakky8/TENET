/**
 * Locks the deterministic-tier PUBLIC API surface.
 *
 * Every composable pre-check factory AND its options type must be reachable
 * from the package entry (`@tenet/verifier`, i.e. `./index.js`), so a caller
 * can assemble a CUSTOM tier without reaching into internal modules. This
 * reddens if an export is dropped from `index.ts` — a silent public-API break
 * that nothing else would catch, since `urlFabricationCheck` /
 * `emailFabricationCheck` have no in-repo consumer outside `defaultPreChecks`.
 *
 * Imports are DELIBERATELY from `./index.js` (the public entry), not
 * `./deterministic.js` (the internal module).
 */
import {
  quoteGroundingCheck,
  numericFabricationCheck,
  urlFabricationCheck,
  emailFabricationCheck,
  runPreChecks,
  type ClaimPreCheck,
  type NumericFabricationOptions,
  type QuoteGroundingOptions,
} from './index.js';

describe('public API — composable deterministic pre-checks', () => {
  it('exposes every check factory from the package entry', () => {
    for (const factory of [
      quoteGroundingCheck,
      numericFabricationCheck,
      urlFabricationCheck,
      emailFabricationCheck,
    ]) {
      expect(typeof factory).toBe('function');
    }
  });

  it('a caller can compose a CUSTOM tier from the public exports and run it', () => {
    // A hand-built tier (NOT defaultPreChecks) — proving the pieces are public
    // and composable, and that the composed tier actually fails a fabrication.
    const tier: ClaimPreCheck[] = [urlFabricationCheck(), emailFabricationCheck()];
    expect(runPreChecks(tier, 'Email billing@fake.example for a refund.', 'no such address here').verdict).toBe('fail');
    expect(runPreChecks(tier, 'See https://fake.example/x for docs.', 'no such url here').verdict).toBe('fail');
    expect(runPreChecks(tier, 'A plain sentence with nothing to check.', 'sources').verdict).toBe('judge');
  });

  it('exposes the options types so a caller can type their config', () => {
    const numOpts: NumericFabricationOptions = { relativeTolerance: 0.005, failBareNumbers: true };
    const quoteOpts: QuoteGroundingOptions = { minQuoteChars: 10, maxResidueChars: 2 };
    expect(typeof numericFabricationCheck(numOpts).check).toBe('function');
    expect(typeof quoteGroundingCheck(quoteOpts).check).toBe('function');
  });
});
