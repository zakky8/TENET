/**
 * Eval framework — interfaces.
 *
 * EvalCase: minimal unit. Input + expected assertions over the produced
 * output. Assertions are pluggable so apps can encode their own checks.
 *
 * EvalDataset: an ordered set of cases.
 *
 * EvalRunner: executes a system-under-test (sut) for each case, scores
 * the output via assertions, returns CaseResult per case + aggregate.
 *
 * RegressionGate: compares a CaseResult set against a baseline; emits
 * a verdict the CI can act on.
 */

export interface EvalCase {
  id: string;
  /** Description shown in failure reports. */
  description?: string;
  /** Free-form input passed to the sut. */
  input: unknown;
  /** Assertions that must hold over the sut's output. */
  assertions: ReadonlyArray<Assertion>;
  /** Optional labels for filtering / cohort analysis. */
  labels?: ReadonlyArray<string>;
}

export interface EvalDataset {
  name: string;
  version: string;
  cases: ReadonlyArray<EvalCase>;
}

export interface AssertContext {
  /** The output the sut produced for this case. */
  output: unknown;
  /** The case being evaluated (useful for assertions to reference). */
  case: EvalCase;
}

export interface Assertion {
  /** Stable id for telemetry. */
  id: string;
  /** Run the assertion. */
  check(ctx: AssertContext): Promise<AssertionResult>;
}

export type AssertionResult =
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string };

/** The system under test. Receives the case input, returns whatever. */
export type Sut = (input: unknown, signal?: AbortSignal) => Promise<unknown>;

export interface CaseResult {
  caseId: string;
  passed: boolean;
  assertions: ReadonlyArray<{ id: string; result: AssertionResult }>;
  durationMs: number;
  /** Stack trace if the sut itself threw. */
  error?: string;
}

export interface RunReport {
  datasetName: string;
  datasetVersion: string;
  results: ReadonlyArray<CaseResult>;
  passed: number;
  failed: number;
  errored: number;
}
