# @tenet/tools-wasm-sandbox

WASM-sandboxed tool execution. Capability model (`networkAllowList`, `readPaths`, `envKeys`), per-call fresh instance, fuel-bounded execution, memory cap, wall-clock timeout.

No `wasmtime` / `wasmer` hard dep — inject any `WasmRuntime`. A reference `NodeWebAssemblyRuntime` uses Node 22's built-in WebAssembly engine; production deployments typically swap in `wasmtime-node` (or similar) that enforces fuel + memory at the engine level for true isolation.
