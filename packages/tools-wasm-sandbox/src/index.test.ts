import {
  WasmToolSandbox,
  WasmPolicyError,
  NodeWebAssemblyRuntime,
  type WasmCapabilities,
  type WasmRuntime,
  type WasmTool,
} from './index.js';

const CAPS_EMPTY: WasmCapabilities = { networkAllowList: [], readPaths: [], envKeys: [] };

// Trivial valid WASM module: 8-byte header (magic + version)
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function mockRuntime(impl: WasmRuntime['execute']): WasmRuntime {
  return { execute: impl };
}

describe('WasmToolSandbox.checkCapabilitiesAllowed', () => {
  it('passes when declared is subset of allowed', () => {
    const r = WasmToolSandbox.checkCapabilitiesAllowed(
      { networkAllowList: ['a.com'], readPaths: ['/data'], envKeys: ['X'] },
      { networkAllowList: ['a.com', 'b.com'], readPaths: ['/data'], envKeys: ['X', 'Y'] },
    );
    expect(r).toBe(true);
  });

  it('rejects on network host outside allow-list', () => {
    const r = WasmToolSandbox.checkCapabilitiesAllowed(
      { networkAllowList: ['evil.com'], readPaths: [], envKeys: [] },
      CAPS_EMPTY,
    );
    expect(r).toMatch(/network host/);
  });

  it('rejects on path outside allow-list', () => {
    const r = WasmToolSandbox.checkCapabilitiesAllowed(
      { networkAllowList: [], readPaths: ['/etc/passwd'], envKeys: [] },
      CAPS_EMPTY,
    );
    expect(r).toMatch(/read path/);
  });

  it('rejects on env key outside allow-list', () => {
    const r = WasmToolSandbox.checkCapabilitiesAllowed(
      { networkAllowList: [], readPaths: [], envKeys: ['SECRET'] },
      CAPS_EMPTY,
    );
    expect(r).toMatch(/env key/);
  });
});

describe('WasmToolSandbox.invoke', () => {
  const tool: WasmTool = {
    name: 'noop',
    module: EMPTY_WASM,
    capabilities: CAPS_EMPTY,
  };

  it('throws tool_not_registered for unknown tool', async () => {
    const sb = new WasmToolSandbox(mockRuntime(async () => ({ output: '', durationMs: 0, fuelUsed: 0 })), []);
    await expect(sb.invoke({ toolName: 'gone', args: {}, tenantId: 'T' })).rejects.toBeInstanceOf(WasmPolicyError);
  });

  it('passes effective policy + capabilities + args to runtime', async () => {
    let captured: Parameters<WasmRuntime['execute']>[0] | undefined;
    const sb = new WasmToolSandbox(
      mockRuntime(async (a) => {
        captured = a;
        return { output: 'r', durationMs: 1, fuelUsed: 100 };
      }),
      [{ ...tool, policy: { timeoutMs: 1500, memoryMaxMb: 32, fuel: 5_000_000 } }],
    );
    await sb.invoke({ toolName: 'noop', args: { x: 1 }, tenantId: 'T' });
    expect(captured!.policy).toEqual({ timeoutMs: 1500, memoryMaxMb: 32, fuel: 5_000_000 });
    expect(captured!.args).toEqual({ x: 1 });
  });

  it('falls back to defaults when policy omitted', async () => {
    let captured: Parameters<WasmRuntime['execute']>[0] | undefined;
    const sb = new WasmToolSandbox(
      mockRuntime(async (a) => {
        captured = a;
        return { output: '', durationMs: 0, fuelUsed: 0 };
      }),
      [tool],
    );
    await sb.invoke({ toolName: 'noop', args: {}, tenantId: 'T' });
    expect(captured!.policy.timeoutMs).toBe(5_000);
    expect(captured!.policy.memoryMaxMb).toBe(64);
    expect(captured!.policy.fuel).toBe(100_000_000);
  });
});

describe('NodeWebAssemblyRuntime — reference', () => {
  it('throws instantiation_failed for non-WASM bytes', async () => {
    const r = new NodeWebAssemblyRuntime();
    await expect(
      r.execute({
        module: new Uint8Array([0xff, 0xff]),
        capabilities: CAPS_EMPTY,
        policy: { timeoutMs: 1000, memoryMaxMb: 4, fuel: 1_000_000 },
        args: {},
      }),
    ).rejects.toBeInstanceOf(WasmPolicyError);
  });
});
