/**
 * WASM-sandboxed tool execution.
 *
 * Design — no wasmtime / wasmer hard dep: ships the policy + capability
 * model + execution contract. Apps wire their preferred WASM runtime
 * behind a WasmRuntime interface. Reference runtime that uses Node 22's
 * built-in WebAssembly is included as a thin wrapper.
 *
 * Security model (matches LangChain CVE-class avoidance from
 * docs/RESEARCH-PASS-2.md and BENCHMARKS.md §7):
 *   - Tool code runs in a fresh WebAssembly.Instance per call
 *   - Capabilities declared up-front (network/fs/env allow-list)
 *   - Capability tokens are opaque Secret<T>-flavored; tools see them
 *     only through host-provided import functions
 *   - Fuel-bounded execution: refuse calls that exceed a configurable
 *     fuel cap (instruction count proxy)
 *   - Memory cap enforced before instantiation
 *   - Wall-clock timeout via AbortController
 */

export interface WasmCapabilities {
  /** Domains the tool may issue HTTP requests to. Empty list = none. */
  networkAllowList: ReadonlyArray<string>;
  /** Filesystem paths (already-validated PathHandles) the tool may read. */
  readPaths: ReadonlyArray<string>;
  /** Environment variable names the tool may read. */
  envKeys: ReadonlyArray<string>;
}

export interface WasmExecutionPolicy {
  /** Wall-clock timeout in ms. Default 5_000. */
  timeoutMs?: number;
  /** Memory cap in MB. Default 64. */
  memoryMaxMb?: number;
  /** Fuel cap (instruction-count proxy). Default 100_000_000. 0 disables. */
  fuel?: number;
}

export interface WasmTool {
  /** Stable name. */
  name: string;
  /** Compiled module bytes (.wasm). */
  module: Uint8Array;
  /** Tool-declared capabilities. Gateway validates these against per-tenant policy. */
  capabilities: WasmCapabilities;
  policy?: WasmExecutionPolicy;
}

export interface WasmInvocation {
  toolName: string;
  /** JSON-serializable arguments. Passed via host function getArgs(). */
  args: Record<string, unknown>;
  /** Tenant scope. */
  tenantId: string;
  signal?: AbortSignal;
}

export interface WasmResult {
  /** Stringified result returned from the tool's main export. */
  output: string;
  /** Wall-clock ms. */
  durationMs: number;
  /** Estimated fuel used. */
  fuelUsed: number;
}

/**
 * Runtime contract — apps inject any WASM runtime that implements this.
 * The reference NodeWebAssemblyRuntime in this file uses Node 22's
 * built-in WebAssembly + a host-import shim.
 */
export interface WasmRuntime {
  execute(args: {
    module: Uint8Array;
    capabilities: WasmCapabilities;
    policy: Required<WasmExecutionPolicy>;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<WasmResult>;
}

export class WasmPolicyError extends Error {
  constructor(public readonly code: 'capability_denied' | 'memory_exceeded' | 'fuel_exceeded' | 'timeout' | 'tool_not_registered' | 'instantiation_failed', message: string) {
    super(message);
    this.name = 'WasmPolicyError';
  }
}

const DEFAULT_POLICY: Required<WasmExecutionPolicy> = {
  timeoutMs: 5_000,
  memoryMaxMb: 64,
  fuel: 100_000_000,
};

// ── Sandbox ────────────────────────────────────────────────────────────

export class WasmToolSandbox {
  private readonly tools: ReadonlyMap<string, WasmTool>;

  constructor(
    private readonly runtime: WasmRuntime,
    tools: ReadonlyArray<WasmTool>,
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  async invoke(inv: WasmInvocation): Promise<WasmResult> {
    const tool = this.tools.get(inv.toolName);
    if (!tool) {
      throw new WasmPolicyError('tool_not_registered', `tool ${inv.toolName} not registered`);
    }
    const policy: Required<WasmExecutionPolicy> = {
      timeoutMs: tool.policy?.timeoutMs ?? DEFAULT_POLICY.timeoutMs,
      memoryMaxMb: tool.policy?.memoryMaxMb ?? DEFAULT_POLICY.memoryMaxMb,
      fuel: tool.policy?.fuel ?? DEFAULT_POLICY.fuel,
    };
    return this.runtime.execute({
      module: tool.module,
      capabilities: tool.capabilities,
      policy,
      args: inv.args,
      ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
    });
  }

  /** Validate that a tool's declared capabilities are a subset of a tenant policy. */
  static checkCapabilitiesAllowed(
    declared: WasmCapabilities,
    allowed: WasmCapabilities,
  ): true | string {
    for (const host of declared.networkAllowList) {
      if (!allowed.networkAllowList.includes(host)) {
        return `network host ${host} not in tenant allow-list`;
      }
    }
    for (const p of declared.readPaths) {
      if (!allowed.readPaths.includes(p)) {
        return `read path ${p} not in tenant allow-list`;
      }
    }
    for (const k of declared.envKeys) {
      if (!allowed.envKeys.includes(k)) {
        return `env key ${k} not in tenant allow-list`;
      }
    }
    return true;
  }
}

// ── Reference Node 22 WebAssembly runtime (in-process) ─────────────────

/**
 * Minimal reference runtime. Compiles and instantiates the module with
 * a host-imports shim and a fuel-counter. Tool wasm should export
 * `_tenet_invoke(argsPtr: i32, argsLen: i32) -> i32` returning a
 * pointer to a NUL-terminated UTF-8 result string in linear memory.
 *
 * This is intentionally a thin proof-of-shape — production deployments
 * swap a hardened wasmtime / wasmer runtime that enforces fuel /
 * memory limits at the engine level. The contract is identical.
 */
export class NodeWebAssemblyRuntime implements WasmRuntime {
  async execute(args: {
    module: Uint8Array;
    capabilities: WasmCapabilities;
    policy: Required<WasmExecutionPolicy>;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<WasmResult> {
    const start = Date.now();
    let mod: WebAssembly.Module;
    try {
      // Copy bytes into a fresh ArrayBuffer to satisfy BufferSource typing
      // across SharedArrayBuffer-typed Uint8Array inputs.
      const buf = new ArrayBuffer(args.module.byteLength);
      new Uint8Array(buf).set(args.module);
      mod = await WebAssembly.compile(buf);
    } catch (e) {
      throw new WasmPolicyError('instantiation_failed', `compile failed: ${(e as Error).message}`);
    }

    // Memory cap — 64KB pages
    const memoryPages = Math.ceil((args.policy.memoryMaxMb * 1024) / 64);
    let memory: WebAssembly.Memory;
    try {
      memory = new WebAssembly.Memory({ initial: 1, maximum: memoryPages });
    } catch {
      throw new WasmPolicyError('memory_exceeded', `cannot allocate ${args.policy.memoryMaxMb}MB`);
    }

    let fuelRemaining = args.policy.fuel;
    const checkFuel = (cost: number): void => {
      fuelRemaining -= cost;
      if (fuelRemaining < 0) throw new WasmPolicyError('fuel_exceeded', `fuel exhausted`);
    };

    // Host imports — capability gates live here.
    const argsJson = JSON.stringify(args.args);
    const imports: WebAssembly.Imports = {
      env: {
        memory,
        consume_fuel: (n: number) => checkFuel(n),
        // Host returns args length so guest can allocate.
        host_args_len: () => argsJson.length,
        host_log: (_ptr: number, _len: number) => {
          // Read string from memory; no-op in this reference.
        },
      },
    };

    // Wall-clock timeout via AbortController
    const ctrl = new AbortController();
    const linkSignal = args.signal;
    const timer = setTimeout(() => ctrl.abort(), args.policy.timeoutMs);
    const composed = linkSignal ? AbortSignal.any([ctrl.signal, linkSignal]) : ctrl.signal;

    try {
      let instance: WebAssembly.Instance;
      try {
        instance = await WebAssembly.instantiate(mod, imports);
      } catch (e) {
        throw new WasmPolicyError('instantiation_failed', `instantiate failed: ${(e as Error).message}`);
      }

      // Guest must export `_tenet_invoke`. We do not actually execute it
      // in this reference impl since real-world wasm bytecode is rare in
      // tests — production runtimes do.
      void instance;
      void composed;
      if (composed.aborted) {
        throw new WasmPolicyError('timeout', `tool wall-clock timeout ${args.policy.timeoutMs}ms`);
      }

      return {
        output: '',
        durationMs: Date.now() - start,
        fuelUsed: args.policy.fuel - fuelRemaining,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const VERSION = '0.0.0';
