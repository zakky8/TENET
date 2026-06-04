/**
 * Eval dataset loader — reads JSON-Lines files from a glob pattern.
 *
 * Uses Node 22's stable `fs.glob` (no third-party glob dep). Each line
 * in each matched file is one EvalCase as JSON. Empty lines and
 * comment lines (starting with `#`) are ignored.
 *
 * Path-safety: glob is rooted at the provided `rootDir` and uses
 * Node's built-in matcher — no shell expansion, no out-of-tree escape.
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { EvalCase, EvalDataset } from './types.js';

export interface LoadDatasetOptions {
  rootDir: string;
  pattern: string;
  name: string;
  version: string;
}

export interface DatasetLoadIssue {
  file: string;
  line: number;
  reason: string;
}

export interface LoadResult {
  dataset: EvalDataset;
  /** Parse failures, one per offending line. Loader does NOT throw on bad lines. */
  issues: ReadonlyArray<DatasetLoadIssue>;
}

/**
 * Load an EvalDataset by globbing JSONL files from rootDir.
 *
 * Bad lines (invalid JSON or missing required fields) are collected
 * into `issues` and skipped. Callers decide whether to fail-fast.
 *
 * Security: patterns containing `..` are rejected at the entry. Each
 * matched path is re-resolved against the absolute rootDir and any
 * file that lands outside rootDir is dropped + recorded as an issue.
 * This is belt + braces — Node's fs.glob already roots at cwd, but
 * symlinks / odd Windows path forms can still surprise.
 */
export async function loadDatasetFromGlob(opts: LoadDatasetOptions): Promise<LoadResult> {
  if (opts.pattern.includes('..')) {
    throw new Error(`loadDatasetFromGlob: pattern may not contain '..' (got ${JSON.stringify(opts.pattern)})`);
  }
  const absRoot = resolve(opts.rootDir);
  const rootWithSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep;

  const cases: EvalCase[] = [];
  const issues: DatasetLoadIssue[] = [];

  // Node 22 stable fs.glob — async iterator over matching paths.
  for await (const absPath of glob(opts.pattern, { cwd: opts.rootDir })) {
    const fullPath = join(opts.rootDir, absPath.toString());
    const resolvedPath = resolve(fullPath);
    // Reject if the resolved path escapes the configured root (symlinks etc.)
    if (resolvedPath !== absRoot && !resolvedPath.startsWith(rootWithSep)) {
      issues.push({
        file: absPath.toString(),
        line: 0,
        reason: `resolved path escapes rootDir`,
      });
      continue;
    }
    const relPath = relative(opts.rootDir, fullPath);
    let text: string;
    try {
      text = await readFile(fullPath, 'utf8');
    } catch (e) {
      issues.push({ file: relPath, line: 0, reason: `read failed: ${(e as Error).message}` });
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        issues.push({
          file: relPath,
          line: idx + 1,
          reason: `invalid JSON: ${(e as Error).message}`,
        });
        return;
      }
      if (!isMinimalEvalCase(parsed)) {
        issues.push({
          file: relPath,
          line: idx + 1,
          reason: 'missing required fields (id, input)',
        });
        return;
      }
      // Assertions must be wired up by the caller — the JSONL format
      // declares them as { id, kind, ...args } shorthand strings; the
      // loader's job is only to materialize the case skeleton.
      cases.push({
        id: parsed.id,
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        input: parsed.input,
        ...(parsed.labels !== undefined ? { labels: parsed.labels } : {}),
        // Assertions empty — caller registers them per-case via id or label.
        assertions: [],
      });
    });
  }

  return {
    dataset: { name: opts.name, version: opts.version, cases },
    issues,
  };
}

interface MinimalCase {
  id: string;
  input: unknown;
  description?: string;
  labels?: ReadonlyArray<string>;
}

function isMinimalEvalCase(v: unknown): v is MinimalCase {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (!('input' in o)) return false;
  if (o.description !== undefined && typeof o.description !== 'string') return false;
  if (
    o.labels !== undefined &&
    (!Array.isArray(o.labels) || !o.labels.every((l) => typeof l === 'string'))
  ) {
    return false;
  }
  return true;
}
