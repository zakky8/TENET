import {
  outcomeEventToSpan,
  OtlpHttpExporter,
  OtlpExportError,
  makeTraceId,
  makeSpanId,
  type OtlpHttp,
} from './index.js';

function mockHttp(status: number, text = ''): { http: OtlpHttp; calls: Array<{ url: string; body: string; headers: Readonly<Record<string, string>> }> } {
  const calls: Array<{ url: string; body: string; headers: Readonly<Record<string, string>> }> = [];
  return {
    http: {
      async fetch(url, init) {
        calls.push({ url, body: init.body, headers: init.headers });
        return { status, text: async () => text };
      },
    },
    calls,
  };
}

describe('outcomeEventToSpan', () => {
  it('converts an OutcomeEvent to OTLP span shape', () => {
    const span = outcomeEventToSpan(
      { kind: 'resolved', tMs: 1_700_000_000_000, tenantId: 't1', conversationId: 'c1' } as any,
      'aabbccddeeff00112233445566778899',
      '0011223344556677',
    );
    expect(span.name).toBe('tenet.outcome.resolved');
    expect(span.attributes).toEqual(expect.arrayContaining([
      { key: 'tenet.event.kind', value: { stringValue: 'resolved' } },
      { key: 'tenet.tenantId', value: { stringValue: 't1' } },
      { key: 'tenet.conversationId', value: { stringValue: 'c1' } },
    ]));
    expect(span.startTimeUnixNano).toBe('1700000000000000000');
  });

  it('coerces non-primitive values to JSON strings', () => {
    const span = outcomeEventToSpan(
      { kind: 'x', tMs: 0, meta: { a: 1, b: [2] } } as any,
      'a'.repeat(32),
      'b'.repeat(16),
    );
    const metaAttr = span.attributes.find((a) => a.key === 'tenet.meta');
    expect(metaAttr).toBeDefined();
    expect((metaAttr!.value as { stringValue: string }).stringValue).toBe('{"a":1,"b":[2]}');
  });
});

describe('OtlpHttpExporter', () => {
  it('requires serviceName', () => {
    const { http } = mockHttp(200);
    expect(() => new OtlpHttpExporter(http, { serviceName: '' })).toThrow();
  });

  it('posts spans to default endpoint with service.name resource attr', async () => {
    const { http, calls } = mockHttp(200);
    const exporter = new OtlpHttpExporter(http, { serviceName: 'tenet-bot' });
    const span = outcomeEventToSpan(
      { kind: 'resolved', tMs: 0 } as any,
      'a'.repeat(32),
      'b'.repeat(16),
    );
    await exporter.export([span]);
    expect(calls[0]!.url).toBe('http://localhost:4318/v1/traces');
    const body = JSON.parse(calls[0]!.body);
    const svcName = body.resourceSpans[0].resource.attributes.find((a: any) => a.key === 'service.name');
    expect(svcName.value.stringValue).toBe('tenet-bot');
  });

  it('forwards custom headers (auth)', async () => {
    const { http, calls } = mockHttp(200);
    const exporter = new OtlpHttpExporter(http, {
      serviceName: 's',
      headers: { authorization: 'Bearer xyz' },
    });
    const span = outcomeEventToSpan({ kind: 'k', tMs: 0 } as any, 'a'.repeat(32), 'b'.repeat(16));
    await exporter.export([span]);
    expect(calls[0]!.headers['authorization']).toBe('Bearer xyz');
  });

  it('throws OtlpExportError on non-2xx', async () => {
    const { http } = mockHttp(500, 'down');
    const exporter = new OtlpHttpExporter(http, { serviceName: 's' });
    const span = outcomeEventToSpan({ kind: 'k', tMs: 0 } as any, 'a'.repeat(32), 'b'.repeat(16));
    await expect(exporter.export([span])).rejects.toBeInstanceOf(OtlpExportError);
  });

  it('no-ops on empty batch', async () => {
    const { http, calls } = mockHttp(200);
    const exporter = new OtlpHttpExporter(http, { serviceName: 's' });
    await exporter.export([]);
    expect(calls).toEqual([]);
  });
});

describe('id helpers', () => {
  it('makeTraceId requires 16 bytes', () => {
    expect(makeTraceId(new Uint8Array(16).fill(0xab))).toBe('ab'.repeat(16));
    expect(() => makeTraceId(new Uint8Array(8))).toThrow();
  });
  it('makeSpanId requires 8 bytes', () => {
    expect(makeSpanId(new Uint8Array(8).fill(0xff))).toBe('ff'.repeat(8));
    expect(() => makeSpanId(new Uint8Array(16))).toThrow();
  });
});
