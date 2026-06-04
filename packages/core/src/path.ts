/**
 * PathHandle factory — the only sanctioned way to produce a PathHandle.
 *
 * Apps register a per-process allow-list root via configurePathRoot().
 * openPath(relative) returns a PathHandle iff the resolved absolute path
 * stays under that root.
 *
 * Rejected at construction time:
 *   - absolute paths in the request
 *   - empty / undefined paths
 *   - paths containing ".." segments (path-traversal)
 *   - resolved paths that escape the configured root
 *
 * This blocks the LangChain CVE-2026-34070-class path-traversal pattern
 * by making it impossible to construct a file-I/O target without going
 * through the validator.
 */

import * as path from 'node:path';
import type { PathHandle } from './types.js';
import { __makePathHandle__ } from './types.js';

let allowedRoot: string | undefined;

/**
 * Configure the per-process allow-list root. Must be called once at
 * startup BEFORE any openPath() call. Idempotent for the same value;
 * throws if reconfigured to a different root.
 */
export function configurePathRoot(root: string): void {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('configurePathRoot: root must be a non-empty string');
  }
  const normalized = path.resolve(root);
  if (allowedRoot !== undefined && allowedRoot !== normalized) {
    throw new Error(
      `configurePathRoot: already configured to ${allowedRoot}; refusing to reconfigure to ${normalized}`,
    );
  }
  allowedRoot = normalized;
}

/** Internal — test-only reset. Not exported through index. */
export function __resetPathRootForTesting__(): void {
  allowedRoot = undefined;
}

/** Return the current allow-list root, or undefined if not configured. */
export function getPathRoot(): string | undefined {
  return allowedRoot;
}

/**
 * Construct a PathHandle for a path relative to the configured root.
 * Throws if the root is not configured, the path is absolute, contains
 * "..", or the resolved path escapes the root.
 */
export function openPath(relative: string): PathHandle {
  if (allowedRoot === undefined) {
    throw new Error(
      'openPath: call configurePathRoot(<allow-list root>) first',
    );
  }
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('openPath: path must be a non-empty string');
  }
  if (path.isAbsolute(relative)) {
    throw new Error(`openPath: absolute paths rejected; got ${JSON.stringify(relative)}`);
  }
  // Reject "..": any segment that's literally ".." OR contains backslash/forward
  // traversal patterns we cannot prove safe.
  const segments = relative.split(/[/\\]/);
  if (segments.some((s) => s === '..')) {
    throw new Error(`openPath: path traversal rejected; got ${JSON.stringify(relative)}`);
  }

  const resolved = path.resolve(allowedRoot, relative);
  const rootWithSep = allowedRoot.endsWith(path.sep) ? allowedRoot : allowedRoot + path.sep;
  if (resolved !== allowedRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `openPath: resolved path ${JSON.stringify(resolved)} escapes root ${JSON.stringify(allowedRoot)}`,
    );
  }

  return __makePathHandle__(resolved);
}
