# @tenet/eval-metrics

Pure, deterministic scorers — one function per BENCHMARKS.md dimension.

No I/O. No fetch. No model calls. Same input → same number, every time. The model-call side lives upstream in `@tenet/eval-harness`; this layer only measures what came back. Auditable, versionable, and hermetic in CI.

Scorers carry `version`; bumping the algorithm bumps that field so historic JSON dumps remain replayable.
