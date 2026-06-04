import type { RouterChatModel } from './types.js';

/**
 * Speculative agent — runs CHEAP and FLAGSHIP in parallel; emits the
 * cheap answer immediately, then a verifier decides whether the cheap
 * answer is good enough or the flagship answer should replace it.
 *
 * The result is a Promise<{ cheap, flagship?, accepted }>; callers can
 * stream the cheap answer to the user while the verifier runs in the
 * background and revoke it if accepted=false.
 *
 * This module ships the orchestration. The actual verifier is plugged
 * in via the verify() callback so apps can use any verification
 * strategy (atomic-claim multi-judge, embedding similarity, rule-based).
 */
export interface SpeculativeOptions {
  cheap: RouterChatModel;
  flagship: RouterChatModel;
  /**
   * Verifier: returns true if cheap answer is acceptable. If false,
   * the flagship answer is returned instead.
   */
  verify: (args: { cheap: string; flagship: string; query: string }) => Promise<boolean>;
  /** Flagship invocation timeout — if exceeded, accept cheap. Default 30s. */
  flagshipTimeoutMs?: number;
}

export interface SpeculativeResult {
  cheap: string;
  flagship?: string;
  accepted: boolean;
  /** Reason: 'cheap-verified' | 'flagship-promoted' | 'flagship-timeout' | 'flagship-error'. */
  reason: string;
}

export class SpeculativeAgent {
  private readonly flagshipTimeoutMs: number;

  constructor(private readonly opts: SpeculativeOptions) {
    this.flagshipTimeoutMs = opts.flagshipTimeoutMs ?? 30_000;
    if (this.flagshipTimeoutMs <= 0) throw new Error('flagshipTimeoutMs must be > 0');
  }

  async run(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<SpeculativeResult> {
    const sharedArgs: Parameters<RouterChatModel['chat']>[0] = {
      system: args.system,
      user: args.user,
      maxTokens: args.maxTokens,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    };

    const cheapPromise = this.opts.cheap.chat(sharedArgs);
    const flagshipCtrl = new AbortController();
    const composedSignal = args.signal
      ? linkSignals(args.signal, flagshipCtrl.signal)
      : flagshipCtrl.signal;
    const flagshipPromise = this.opts.flagship.chat({
      ...sharedArgs,
      signal: composedSignal,
    });

    // ES2024 Promise.withResolvers — same pattern as withTimeoutAndSignal.
    const { promise: flagshipWithTimeout, resolve, reject } =
      Promise.withResolvers<string | typeof TIMEOUT>();
    const flagshipTimer = setTimeout(() => resolve(TIMEOUT), this.flagshipTimeoutMs);
    flagshipPromise.then(
      (v) => resolve(v),
      (e) => reject(e),
    );

    let cheapResult: string;
    try {
      cheapResult = await cheapPromise;
    } catch (e) {
      // Cheap broke — wait for flagship as the only option
      const fl = await flagshipPromise.catch(() => {
        throw e;
      });
      clearTimeout(flagshipTimer);
      return { cheap: '', flagship: fl, accepted: false, reason: 'cheap-error' };
    }

    let flagshipResult: string | typeof TIMEOUT;
    try {
      flagshipResult = await flagshipWithTimeout;
    } catch {
      clearTimeout(flagshipTimer);
      flagshipCtrl.abort();
      return { cheap: cheapResult, accepted: true, reason: 'flagship-error' };
    }
    if (flagshipTimer) clearTimeout(flagshipTimer);

    if (flagshipResult === TIMEOUT) {
      flagshipCtrl.abort();
      return { cheap: cheapResult, accepted: true, reason: 'flagship-timeout' };
    }

    const cheapOk = await this.opts.verify({
      cheap: cheapResult,
      flagship: flagshipResult,
      query: args.user,
    });

    if (cheapOk) {
      return {
        cheap: cheapResult,
        flagship: flagshipResult,
        accepted: true,
        reason: 'cheap-verified',
      };
    }
    return {
      cheap: cheapResult,
      flagship: flagshipResult,
      accepted: false,
      reason: 'flagship-promoted',
    };
  }
}

const TIMEOUT = Symbol('flagship-timeout');

function linkSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  if (a.aborted || b.aborted) ctrl.abort();
  a.addEventListener('abort', () => ctrl.abort(), { once: true });
  b.addEventListener('abort', () => ctrl.abort(), { once: true });
  return ctrl.signal;
}
