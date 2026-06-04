import type { RunReport } from './types.js';

export interface BaselineSummary {
  datasetName: string;
  datasetVersion: string;
  passRate: number; // 0..1
}

export type GateVerdict =
  | { ok: true }
  | { ok: false; reason: string; deltaPassRate: number };

export interface GateOptions {
  /** Max allowed drop in pass rate. Default 0.0 (no regression). */
  maxPassRateDropAbs?: number;
  /** Require dataset name + version to match the baseline. Default true. */
  requireSameDataset?: boolean;
}

/** Decide whether a RunReport regresses vs a saved baseline. */
export function gate(
  report: RunReport,
  baseline: BaselineSummary,
  opts: GateOptions = {},
): GateVerdict {
  const requireSame = opts.requireSameDataset ?? true;
  const maxDrop = opts.maxPassRateDropAbs ?? 0.0;

  if (requireSame) {
    if (report.datasetName !== baseline.datasetName) {
      return {
        ok: false,
        reason: `dataset name mismatch: report=${report.datasetName} baseline=${baseline.datasetName}`,
        deltaPassRate: 0,
      };
    }
    if (report.datasetVersion !== baseline.datasetVersion) {
      return {
        ok: false,
        reason: `dataset version mismatch: report=${report.datasetVersion} baseline=${baseline.datasetVersion}`,
        deltaPassRate: 0,
      };
    }
  }

  const total = report.passed + report.failed + report.errored;
  const passRate = total > 0 ? report.passed / total : 1;
  const drop = baseline.passRate - passRate;
  if (drop > maxDrop) {
    return {
      ok: false,
      reason: `pass rate dropped ${(drop * 100).toFixed(2)}% (baseline ${(baseline.passRate * 100).toFixed(2)}% → ${(passRate * 100).toFixed(2)}%); allowed ${(maxDrop * 100).toFixed(2)}%`,
      deltaPassRate: -drop,
    };
  }
  return { ok: true };
}

/** Distill a RunReport into a baseline. */
export function summarize(report: RunReport): BaselineSummary {
  const total = report.passed + report.failed + report.errored;
  const passRate = total > 0 ? report.passed / total : 1;
  return {
    datasetName: report.datasetName,
    datasetVersion: report.datasetVersion,
    passRate,
  };
}
