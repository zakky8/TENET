import { MCPGateway, MCPGatewayError, type AuditRecord } from './index.js';
import type { ToolDefinition } from '@tenet/tools-mcp';

function tool(name: string, returns = 'ok'): ToolDefinition {
  return {
    name,
    description: '',
    inputSchema: { type: 'object' },
    async invoke() {
      return returns;
    },
  };
}

const OAUTH = { iss: 'https://issuer.example.com', sub: 'u', token: 'tok' };

describe('MCPGateway — invoke happy path', () => {
  it('runs the tool when tenant + tool + iss all permitted', async () => {
    const audits: AuditRecord[] = [];
    const g = new MCPGateway({
      tools: [tool('echo', 'echoed')],
      policies: {
        'tenant-A': { allowedTools: ['echo'], trustedIssuers: [OAUTH.iss] },
      },
      audit: { record: (r) => audits.push(r) },
    });
    const result = await g.invoke({ tenantId: 'tenant-A', toolName: 'echo', args: {}, oauth: OAUTH });
    expect(result).toBe('echoed');
    expect(audits[0]!.outcome).toBe('allow');
  });

  it("'*' in allowedTools acts as wildcard", async () => {
    const g = new MCPGateway({
      tools: [tool('echo'), tool('add')],
      policies: { T: { allowedTools: ['*'], trustedIssuers: [OAUTH.iss] } },
    });
    await expect(g.invoke({ tenantId: 'T', toolName: 'echo', args: {}, oauth: OAUTH })).resolves.toBe('ok');
    await expect(g.invoke({ tenantId: 'T', toolName: 'add', args: {}, oauth: OAUTH })).resolves.toBe('ok');
  });
});

describe('MCPGateway — denial paths', () => {
  it('throws tenant_unregistered when tenant has no policy', async () => {
    const audits: AuditRecord[] = [];
    const g = new MCPGateway({
      tools: [tool('echo')],
      policies: {},
      audit: { record: (r) => audits.push(r) },
    });
    await expect(g.invoke({ tenantId: 'unknown', toolName: 'echo', args: {}, oauth: OAUTH })).rejects.toBeInstanceOf(MCPGatewayError);
    expect(audits[0]!.outcome).toBe('deny');
  });

  it('throws unknown_tool when tool not registered', async () => {
    const g = new MCPGateway({
      tools: [tool('echo')],
      policies: { T: { allowedTools: ['*'], trustedIssuers: [OAUTH.iss] } },
    });
    await expect(g.invoke({ tenantId: 'T', toolName: 'never-registered', args: {}, oauth: OAUTH })).rejects.toThrow(/unknown_tool|tool .* not registered/);
  });

  it('throws tool_not_allowed when tool not in allow-list', async () => {
    const g = new MCPGateway({
      tools: [tool('echo'), tool('add')],
      policies: { T: { allowedTools: ['echo'], trustedIssuers: [OAUTH.iss] } },
    });
    await expect(g.invoke({ tenantId: 'T', toolName: 'add', args: {}, oauth: OAUTH })).rejects.toThrow(/not in tenant allow-list/);
  });

  it('throws untrusted_issuer when oauth.iss not in trustedIssuers (RFC 9207 / SEP-2468)', async () => {
    const g = new MCPGateway({
      tools: [tool('echo')],
      policies: { T: { allowedTools: ['*'], trustedIssuers: ['https://other-issuer.example'] } },
    });
    await expect(
      g.invoke({ tenantId: 'T', toolName: 'echo', args: {}, oauth: OAUTH }),
    ).rejects.toThrow(/not in tenant trusted-issuer list/);
  });
});

describe('MCPGateway — per-tool rate limit', () => {
  it('throws rate_limited when calls/minute exceeded', async () => {
    let t = 1_000_000;
    const g = new MCPGateway({
      tools: [tool('echo')],
      policies: {
        T: { allowedTools: ['*'], trustedIssuers: [OAUTH.iss], perToolRateLimit: { echo: 2 } },
      },
      now: () => t,
    });
    await g.invoke({ tenantId: 'T', toolName: 'echo', args: {}, oauth: OAUTH });
    await g.invoke({ tenantId: 'T', toolName: 'echo', args: {}, oauth: OAUTH });
    await expect(
      g.invoke({ tenantId: 'T', toolName: 'echo', args: {}, oauth: OAUTH }),
    ).rejects.toThrow(/rate_limited|exceeded/);
  });

  it('window slides after 60s', async () => {
    let t = 1_000_000;
    const g = new MCPGateway({
      tools: [tool('echo')],
      policies: {
        T: { allowedTools: ['*'], trustedIssuers: [OAUTH.iss], perToolRateLimit: { echo: 1 } },
      },
      now: () => t,
    });
    await g.invoke({ tenantId: 'T', toolName: 'echo', args: {}, oauth: OAUTH });
    t += 61_000;
    await expect(g.invoke({ tenantId: 'T', toolName: 'echo', args: {}, oauth: OAUTH })).resolves.toBe('ok');
  });
});

describe('MCPGateway — audit', () => {
  it("records 'error' when underlying tool throws", async () => {
    const audits: AuditRecord[] = [];
    const failingTool: ToolDefinition = {
      name: 'broken',
      description: '',
      inputSchema: {},
      async invoke() {
        throw new Error('tool down');
      },
    };
    const g = new MCPGateway({
      tools: [failingTool],
      policies: { T: { allowedTools: ['*'], trustedIssuers: [OAUTH.iss] } },
      audit: { record: (r) => audits.push(r) },
    });
    await expect(g.invoke({ tenantId: 'T', toolName: 'broken', args: {}, oauth: OAUTH })).rejects.toThrow('tool down');
    expect(audits[0]!.outcome).toBe('error');
    expect(audits[0]!.reason).toBe('tool down');
  });

  it('audit sink errors do not break invoke', async () => {
    const brokenSink = {
      record() {
        throw new Error('sink broken');
      },
    };
    const g = new MCPGateway({
      tools: [tool('echo')],
      policies: { T: { allowedTools: ['*'], trustedIssuers: [OAUTH.iss] } },
      audit: brokenSink,
    });
    await expect(g.invoke({ tenantId: 'T', toolName: 'echo', args: {}, oauth: OAUTH })).resolves.toBe('ok');
  });
});
