# @tenet/judge-hhem

Vectara HHEM-2.1 hallucination judge adapter. The atomic-claim verifier ships LLM-as-judge by default; LLM judges agree with themselves and inflate scores. HHEM-2.1 is a calibrated independent cross-encoder — the industry-standard third-party hallucination detector on the Vectara leaderboard.

No `@huggingface/transformers` / `onnxruntime` hard dep. Inject any `HhemScorer` — a local `transformers.js` pipeline, a hosted endpoint, or a self-hosted Triton instance. The included `TOKEN_OVERLAP_SCORER` is a deterministic reference for offline CI; production swaps in the real cross-encoder.

The interface produces `HallucinationVerdict` shapes (`@tenet/eval-metrics`) so the result slots straight into the BENCHMARKS gate without translation.
