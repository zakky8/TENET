import { WasmtimeRuntime, type WasmtimeBinding, type WasmtimeStore, type WasmtimeInstance } from './index.js';
import { WasmPolicyError } from '@tenet/tools-wasm-sandbox';

function makeStore(fuel: number): WasmtimeStore {
  let remaining = fuel;
  return {
    fuelRemaining: () => remaining,
    bytesAllocated: () => 0,
    dispose: () => { remaining = 0; },
  };
}

function makeBinding(
  invokeImpl: (name: string, args: ReadonlyArray<unknown>) => Promise<unknown>,
  storeOverride?: () => WasmtimeStore,
): WasmtimeBinding {
  return {
    createStore: ({ fuel }) => storeOverride?.() ?? makeStore(fuel),
    async instantiate(): Promise<WasmtimeInstance> {
      return { invoke: invokeImpl };
    },
  };
}

const CAPS_EMPTY = { networkAllowList: [], readPaths: [], envKeys: [] };
const POLICY = { timeoutMs: 5_000, memoryMaxMb: 64, fuel: 1_000_000 };
const EMPTY_MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

describe('WasmtimeRuntime', () => {
  it('invokes _tenet_invoke and returns its output as string', async () => {
    const calls: Array<{ name: string; args: ReadonlyArray<unknown> }> = [];
    const rt = new WasmtimeRuntime({
      binding: makeBinding(async (name, args) => {
        calls.push({ name, args });
        return 'hello';
      }),
    });
    const result = await rt.execute({
      module: EMPTY_MODULE,
      capabilities: CAPS_EMPTY,
      policy: POLICY,
      args: { q: 'x' },
    });
    expect(result.output).toBe('hello');
    expect(calls[0]!.name).toBe('_tenet_invoke');
    expect(result.fuelUsed).toBe(0); // store unchanged in our fake
  });

  it('translates "out of fuel" engine error to fuel_exceeded code', async () => {
    const rt = new WasmtimeRuntime({
      binding: makeBinding(async () => {
        throw new Error('engine reports: out of fuel');
      }),
    });
    await expect(
      rt.execute({ module: EMPTY_MODULE, capabilities: CAPS_EMPTY, policy: POLICY, args: {} }),
    ).rejects.toMatchObject({ code: 'fuel_exceeded' });
  });

  it('translates memory error to memory_exceeded code', async () => {
    const rt = new WasmtimeRuntime({
      binding: makeBinding(async () => {
        throw new Error('memory allocation failed');
      }),
    });
    await expect(
      rt.execute({ module: EMPTY_MODULE, capabilities: CAPS_EMPTY, policy: POLICY, args: {} }),
    ).rejects.toMatchObject({ code: 'memory_exceeded' });
  });

  it('createStore failure → instantiation_failed', async () => {
    const rt = new WasmtimeRuntime({
      binding: {
        createStore: () => { throw new Error('boom'); },
        instantiate: async () => ({ invoke: async () => '' }),
      },
    });
    await expect(
      rt.execute({ module: EMPTY_MODULE, capabilities: CAPS_EMPTY, policy: POLICY, args: {} }),
    ).rejects.toMatchObject({ code: 'instantiation_failed' });
  });

  it('host_http_request denied when networkAllowList empty', async () => {
    let importsCaptured: any;
    const binding: WasmtimeBinding = {
      createStore: () => makeStore(POLICY.fuel),
      async instantiate(args) {
        importsCaptured = args.imports;
        return { invoke: async () => '' };
      },
    };
    const rt = new WasmtimeRuntime({ binding });
    await rt.execute({ module: EMPTY_MODULE, capabilities: CAPS_EMPTY, policy: POLICY, args: {} });
    expect(() => importsCaptured.env.host_http_request(0, 0)).toThrow(WasmPolicyError);
  });

  it('host_http_request allowed when networkAllowList non-empty', async () => {
    let importsCaptured: any;
    const binding: WasmtimeBinding = {
      createStore: () => makeStore(POLICY.fuel),
      async instantiate(args) {
        importsCaptured = args.imports;
        return { invoke: async () => '' };
      },
    };
    const rt = new WasmtimeRuntime({ binding });
    await rt.execute({
      module: EMPTY_MODULE,
      capabilities: { networkAllowList: ['api.example.com'], readPaths: [], envKeys: [] },
      policy: POLICY,
      args: {},
    });
    expect(importsCaptured.env.host_http_request(0, 0)).toBe(0);
  });

  it('fuelUsed = policy.fuel - store.fuelRemaining() after invoke', async () => {
    const store: WasmtimeStore = {
      fuelRemaining: () => 400_000,
      bytesAllocated: () => 0,
      dispose: () => {},
    };
    const rt = new WasmtimeRuntime({
      binding: makeBinding(async () => 'ok', () => store),
    });
    const r = await rt.execute({
      module: EMPTY_MODULE,
      capabilities: CAPS_EMPTY,
      policy: POLICY,
      args: {},
    });
    expect(r.fuelUsed).toBe(600_000);
  });

  it('passes through abort signal composition', async () => {
    let invokeSignal: AbortSignal | undefined;
    const binding: WasmtimeBinding = {
      createStore: () => makeStore(POLICY.fuel),
      async instantiate(args) {
        invokeSignal = args.signal;
        return { invoke: async () => '' };
      },
    };
    const rt = new WasmtimeRuntime({ binding });
    const ctrl = new AbortController();
    await rt.execute({
      module: EMPTY_MODULE,
      capabilities: CAPS_EMPTY,
      policy: POLICY,
      args: {},
      signal: ctrl.signal,
    });
    expect(invokeSignal).toBeDefined();
    // It's a composed signal — not strictly === ctrl.signal.
    expect(invokeSignal!.aborted).toBe(false);
  });
});
