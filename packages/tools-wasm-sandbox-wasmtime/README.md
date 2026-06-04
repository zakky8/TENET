# @tenet/tools-wasm-sandbox-wasmtime

Production WasmRuntime adapter for `@tenet/tools-wasm-sandbox`. The reference `NodeWebAssemblyRuntime` shipped in the base package is intentionally thin — Node's built-in WebAssembly cannot reliably enforce fuel or memory at the engine level. This adapter delegates to wasmtime (or any `WasmtimeBinding`-shaped engine) which can.

No `wasmtime-node` hard dep — inject any binding that implements `WasmtimeBinding`. Drop-in: same `WasmRuntime` contract, same `WasmPolicyError` codes, same `WasmResult` shape. Swap one for the other in app composition; no other code changes.
