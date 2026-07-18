// Context declarations for `pnpm examples:check` (scripts/check-doc-examples.mjs).
//
// The @tenet/refine README's ts fences are ILLUSTRATIVE — they call `model.chat(…)`,
// `index.query(…)`, etc. on vars the reader supplies, left undeclared in the snippet.
// Undeclared vars are typed `any`, so the gate cannot see a wrong ARGUMENT shape
// (e.g. the historical `model.chat({ system, user })` where ChatRequest has no `user`).
// The gate prepends this sidecar (named `<doc>.examples.d.ts`) to each fence so those
// context vars are TYPED and their calls are deep-checked against the real API.
//
// It is NOT part of the shipped package: refine's tsconfig only includes `src/**/*`,
// so `tsc`/`pnpm -r build` never compiles this file. Keep the types matching how the
// README actually uses each var — a wrong type here would false-FAIL a valid example.
import type { ChatModel } from '@tenet/core';

declare const model: ChatModel;
declare const index: {
  query(a: { text: string; k: number }): ReadonlyArray<{ source: unknown; score: number }>;
};
declare const question: string;
declare const sources: string;
declare const system: string;
declare const rewriteSystem: string;
declare function send(s: string): void;
declare function handoff(s: string): void;
