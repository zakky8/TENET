/**
 * stdio transport — the spec-default for local ACP agents.
 *
 * Wire framing: one JSON-RPC message per line (newline-delimited JSON).
 * No Content-Length header (LSP-style framing is NOT used by ACP).
 *
 * Operator wires stdin → parseStdinFrame → AcpAgent.dispatch and
 * AcpAgent's outbound → process.stdout.write.
 */

import type { AcpOutboundSink } from './agent.js';
import type { JsonRpcMessage, JsonRpcRequest } from './types.js';

/** Build an outbound sink that writes one NDJSON frame per send. */
export function ndjsonSink(write: (chunk: string) => void): AcpOutboundSink {
  return {
    send(msg) {
      write(JSON.stringify(msg) + '\n');
    },
  };
}

/**
 * Stream parser — feed it chunks of stdin bytes, yields complete
 * JSON-RPC messages line-by-line. Tolerates split chunks and CRLF.
 */
export function createNdjsonParser(): {
  feed(chunk: string): JsonRpcMessage[];
  finish(): JsonRpcMessage[];
} {
  let buf = '';
  const MAX_LINE = 4 * 1024 * 1024; // 4 MiB safety cap
  const parseOne = (line: string): JsonRpcMessage | null => {
    if (line === '') return null;
    try {
      const msg = JSON.parse(line);
      if (msg && typeof msg === 'object') return msg as JsonRpcMessage;
    } catch {
      /* fall through */
    }
    return null;
  };
  return {
    feed(chunk: string): JsonRpcMessage[] {
      buf += chunk;
      if (buf.length > MAX_LINE) throw new Error(`ACP stdin line exceeded ${MAX_LINE} bytes`);
      const out: JsonRpcMessage[] = [];
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        const msg = parseOne(line);
        if (msg) out.push(msg);
      }
      return out;
    },
    finish(): JsonRpcMessage[] {
      const remaining = buf.trim();
      buf = '';
      const msg = parseOne(remaining);
      return msg ? [msg] : [];
    },
  };
}

/**
 * Convenience predicate — narrow a JsonRpcMessage to a request shape
 * (has an id + a method, no result/error/sole-method-notification).
 */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return (
    typeof (msg as { method?: unknown }).method === 'string' &&
    (msg as { id?: unknown }).id !== undefined
  );
}
