import { textMessage, responseText } from '@tenet/core';
import type { RouteClassifier, RouteDecision, RouterChatModel } from './types.js';

/**
 * Adaptive cost-aware router.
 *
 * Per turn:
 *   1. Classifier picks a tier (cheap / flagship / etc).
 *   2. If classifier confidence < confidenceFloor, falls back to flagship.
 *   3. Router invokes the picked tier's RouterChatModel.
 *
 * Apps register models per-tier and a classifier. Default behavior:
 *   - 'cheap' tier handles simple / well-classified queries
 *   - 'flagship' tier handles uncertain / complex queries
 *   - On any picked-tier error, falls back to flagship once.
 */
export interface AdaptiveRouterOptions {
  classifier: RouteClassifier;
  tiers: Readonly<Record<string, RouterChatModel>>;
  /** Tier id to use when classifier confidence drops below floor. Default 'flagship'. */
  flagshipTier?: string;
  /** Below this classifier confidence → flagship. Default 0.6. */
  confidenceFloor?: number;
}

export interface RouterOutput {
  text: string;
  tierUsed: string;
  decision: RouteDecision;
  fellBackToFlagship: boolean;
}

export class AdaptiveRouter {
  private readonly flagshipTier: string;
  private readonly confidenceFloor: number;

  constructor(private readonly opts: AdaptiveRouterOptions) {
    this.flagshipTier = opts.flagshipTier ?? 'flagship';
    this.confidenceFloor = opts.confidenceFloor ?? 0.6;
    if (this.confidenceFloor < 0 || this.confidenceFloor > 1) {
      throw new Error('confidenceFloor must be in [0,1]');
    }
    if (!opts.tiers[this.flagshipTier]) {
      throw new Error(`flagshipTier '${this.flagshipTier}' not registered in tiers`);
    }
  }

  async route(args: {
    text: string;
    intent?: string;
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<RouterOutput> {
    const decision = await this.opts.classifier.classify({
      text: args.text,
      ...(args.intent !== undefined ? { intent: args.intent } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });

    const lowConfidence = decision.confidence < this.confidenceFloor;
    const initialTier = lowConfidence ? this.flagshipTier : decision.tier;
    const initialModel = this.opts.tiers[initialTier];

    if (!initialModel) {
      // Unknown tier — fall back to flagship
      return this.invokeWithFallback(args, decision, this.flagshipTier, true);
    }

    try {
      const res = await initialModel.chat({
        system: args.system,
        messages: [textMessage('user', args.user)],
        maxTokens: args.maxTokens,
        signal: args.signal ?? new AbortController().signal,
      });
      const text = responseText(res);
      return { text, tierUsed: initialTier, decision, fellBackToFlagship: lowConfidence };
    } catch (e) {
      if (initialTier === this.flagshipTier) throw e;
      return this.invokeWithFallback(args, decision, this.flagshipTier, true);
    }
  }

  private async invokeWithFallback(
    args: { system: string; user: string; maxTokens: number; signal?: AbortSignal },
    decision: RouteDecision,
    tier: string,
    fellBack: boolean,
  ): Promise<RouterOutput> {
    const model = this.opts.tiers[tier];
    if (!model) throw new Error(`Tier ${tier} not registered`);
    const res = await model.chat({
      system: args.system,
      messages: [textMessage('user', args.user)],
      maxTokens: args.maxTokens,
      signal: args.signal ?? new AbortController().signal,
    });
    const text = responseText(res);
    return { text, tierUsed: tier, decision, fellBackToFlagship: fellBack };
  }
}
