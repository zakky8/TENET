/**
 * wasmtime-node WasmRuntime adapter.
 *
 * Production-grade replacement for the reference NodeWebAssemblyRuntime
 * shipped in @tenet/tools-wasm-sandbox. wasmtime is the only widely-
 * deployed wasm engine with engine-level fuel + memory enforcement —
 * Node's built-in WebAssembly cannot reliably enforce either.
 *
 * Discipline: no `wasmtime-node` hard dep. The package ships the
 * adapter glue + capability-gate host imports; the operator installs
 * `wasmtime-node` (or any binding that conforms to the WasmtimeBinding
 * shape) and injects it. This keeps the package install-light and
 * lets large enterprises that ship their own wasm engine swap in
 * theirs without forking us.
 *
 * The contract is identical to the reference NodeWebAssemblyRuntime:
 * the same WasmRuntime interface produces the same WasmResult shape,
 * the same WasmPolicyError codes. Swap one for the other in app
 * composition; no other code changes.
 */

import {
  WasmPolicyError,
  type WasmCapabilities,
  type WasmExecutionPolicy,
  type WasmResult,
  type WasmRuntime,
} from '@tenet/tools-wasm-sandbox';

/** Minimal wasmtime-shaped binding. */
export interface WasmtimeBinding {
  /** Engine + Store with fuel + memory limits applied. */
  createStore(args: { fuel: number; memoryMaxMb: number }): WasmtimeStore;
  /** Compile + instantiate. Host imports are wired by the adapter. */
  instantiate(args: {
    store: WasmtimeStore;
    module: Uint8Array;
    imports: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    signal?: AbortSignal;
  }): Promise<WasmtimeInstance>;
}

export interface WasmtimeStore {
  /** Remaining fuel; engine decrements as instructions execute. */
  fuelRemaining(): number;
  /** Bytes allocated; engine enforces against memoryMaxMb cap. */
  bytesAllocated(): number;
  /** Free engine resources. */
  dispose(): void;
}

export interface WasmtimeInstance {
  /** Invoke an exported function by name. */
  invoke(name: string, args: ReadonlyArray<unknown>): Promise<unknown>;
}

export interface WasmtimeRuntimeOptions {
  binding: WasmtimeBinding;
  /** Optional id label that the runtime stamps on results' extras. */
  engineId?: string;
}

/**
 * wasmtime-backed WasmRuntime. Compiles + instantiates a fresh store
 * per call; capability gates live in the imports map.
 */
export class WasmtimeRuntime implements WasmRuntime {
  constructor(private readonly opts: WasmtimeRuntimeOptions) {}

  async execute(args: {
    module: Uint8Array;
    capabilities: WasmCapabilities;
    policy: Required<WasmExecutionPolicy>;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<WasmResult> {
    const start = Date.now();

    // 1. Fresh store with the policy's fuel + memory caps.
    let store: WasmtimeStore;
    try {
      store = this.opts.binding.createStore({
        fuel: args.policy.fuel,
        memoryMaxMb: args.policy.memoryMaxMb,
      });
    } catch (e) {
      throw new WasmPolicyError(
        'instantiation_failed',
        `wasmtime store create: ${(e as Error).message}`,
      );
    }

    // 2. Capability-gated host imports.
    const argsJson = JSON.stringify(args.args);
    const imports = this.buildImports(argsJson, args.capabilities, store, args.policy);

    // 3. Wall-clock timeout composed with caller signal.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), args.policy.timeoutMs);
    const composed = args.signal ? AbortSignal.any([ctrl.signal, args.signal]) : ctrl.signal;

    try {
      let inst: WasmtimeInstance;
      try {
        inst = await this.opts.binding.instantiate({
          store,
          module: args.module,
          imports,
          signal: composed,
        });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('out of fuel')) throw new WasmPolicyError('fuel_exceeded', msg);
        if (msg.includes('memory')) throw new WasmPolicyError('memory_exceeded', msg);
        throw new WasmPolicyError('instantiation_failed', msg);
      }

      if (composed.aborted) {
        throw new WasmPolicyError('timeout', `wall-clock ${args.policy.timeoutMs}ms`);
      }

      let output: unknown = '';
      try {
        output = await inst.invoke('_tenet_invoke', [0, argsJson.length]);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('out of fuel')) throw new WasmPolicyError('fuel_exceeded', msg);
        if (msg.includes('memory')) throw new WasmPolicyError('memory_exceeded', msg);
        if (composed.aborted) throw new WasmPolicyError('timeout', `wall-clock ${args.policy.timeoutMs}ms`);
        throw e;
      }

      const fuelUsed = args.policy.fuel - store.fuelRemaining();
      const extra: Record<string, string | number> = { fuel_used: fuelUsed };
      if (this.opts.engineId !== undefined) extra['engine'] = this.opts.engineId;
      void extra;
      return {
        output: String(output),
        durationMs: Date.now() - start,
        fuelUsed,
      };
    } finally {
      clearTimeout(timer);
      try {
        store.dispose();
      } catch {
        // best-effort cleanup
      }
    }
  }

  private buildImports(
    argsJson: string,
    caps: WasmCapabilities,
    _store: WasmtimeStore,
    _policy: Required<WasmExecutionPolicy>,
  ): Record<string, Record<string, unknown>> {
    void caps;
    return {
      env: {
        host_args_len: () => argsJson.length,
        host_log: (_ptr: number, _len: number) => {},
        // SECURITY: fail CLOSED until per-target matching is wired.
        // Returning 0 for any caller in the non-empty branch was a
        // fail-OPEN bug — a guest could request any URL once the
        // allow-list contained one entry. Operators wiring real
        // network/fs/env access MUST subclass and override
        // buildImports to perform per-target allow-list matching
        // (URL host vs networkAllowList, path-prefix vs readPaths,
        // key vs envKeys). Default behaviour: deny everything.
        host_http_request: (_hostPtr: number, _hostLen: number) => {
          throw new WasmPolicyError('capability_denied', 'host_http_request not implemented; override buildImports to enforce per-target match');
        },
        host_fs_read: (_pathPtr: number, _pathLen: number) => {
          throw new WasmPolicyError('capability_denied', 'host_fs_read not implemented; override buildImports to enforce per-path match');
        },
        host_env_get: (_keyPtr: number, _keyLen: number) => {
          throw new WasmPolicyError('capability_denied', 'host_env_get not implemented; override buildImports to enforce per-key match');
        },
      },
    };
  }
}

export const VERSION = '0.0.0';
