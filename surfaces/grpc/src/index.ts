/**
 * gRPC surface — protobuf service shape + framework-agnostic handler.
 *
 * No grpc-js / @grpc/grpc-js / @connectrpc/connect hard dep. We ship:
 *   - the protobuf-shaped TypeScript types for the two RPCs
 *   - a `handleConverse` and `handleConverseStream` function that
 *     production wraps in their preferred gRPC runtime (grpc-js
 *     server, connect-rpc handler, Twirp, etc.)
 *
 * Proto service (`.proto` document also exported as PROTO_SOURCE):
 *
 *   service TenetAgent {
 *     rpc Converse(ConverseRequest) returns (ConverseResponse);
 *     rpc ConverseStream(ConverseRequest) returns (stream ConverseChunk);
 *   }
 *
 * Apps run `protoc` / `buf` once, generate stubs, and route incoming
 * calls into the handlers exported here.
 */

import type { NormalizedEvent, NormalizedReply } from '@tenet/core';

// ── Proto-shaped types ────────────────────────────────────────────────

export interface ConverseRequest {
  /** End-user id (subject). */
  sub: string;
  /** Tenant id. */
  tnt: string;
  /** Conversation id. Empty string → default to sub. */
  conversationId: string;
  /** Question text. */
  text: string;
}

export interface ConverseResponse {
  reply: string;
  citations: ReadonlyArray<{ sourceId: string; quote: string }>;
  conversationId: string;
}

export type ConverseChunk =
  | { kind: 'chunk'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

// ── Handler shapes ─────────────────────────────────────────────────────

export interface GrpcSurfaceOptions {
  /** Single-turn handler. */
  handle: (event: NormalizedEvent, signal?: AbortSignal) => Promise<NormalizedReply>;
  /** Streaming handler. Yields plain text chunks. */
  stream?: (event: NormalizedEvent, signal?: AbortSignal) => AsyncIterable<string>;
  /** Authorization extracted from gRPC metadata; throws on invalid. */
  authenticate: (metadata: Readonly<Record<string, string>>) => Promise<{ sub: string; tnt: string }>;
}

export class GrpcSurface {
  readonly name = 'grpc';

  constructor(private readonly opts: GrpcSurfaceOptions) {
    if (!opts.handle) throw new Error('GrpcSurface: handle fn required');
    if (!opts.authenticate) throw new Error('GrpcSurface: authenticate fn required');
  }

  async converse(
    req: ConverseRequest,
    metadata: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<ConverseResponse> {
    const { sub, tnt } = await this.opts.authenticate(metadata);
    // Caller-provided sub/tnt override only if authenticate result agrees.
    if (req.sub !== '' && req.sub !== sub) {
      throw new Error('sub in request body does not match authenticated identity');
    }
    if (req.tnt !== '' && req.tnt !== tnt) {
      throw new Error('tnt in request body does not match authenticated identity');
    }
    if (!req.text || req.text.trim().length === 0) {
      throw new Error('text required');
    }
    const conversationId = req.conversationId || sub;
    const event: NormalizedEvent = {
      surface: this.name,
      tenantId: tnt,
      conversationId,
      userId: sub,
      text: req.text,
      receivedAt: Date.now(),
    };
    const reply = await this.opts.handle(event, signal);
    return {
      reply: reply.text,
      citations: reply.citations.map((c) => ({ sourceId: c.sourceId, quote: c.quote })),
      conversationId,
    };
  }

  async *converseStream(
    req: ConverseRequest,
    metadata: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): AsyncIterable<ConverseChunk> {
    if (!this.opts.stream) {
      yield { kind: 'error', message: 'streaming not configured' };
      return;
    }
    let sub: string;
    let tnt: string;
    try {
      ({ sub, tnt } = await this.opts.authenticate(metadata));
    } catch (e) {
      yield { kind: 'error', message: (e as Error).message };
      return;
    }
    if (!req.text || req.text.trim().length === 0) {
      yield { kind: 'error', message: 'text required' };
      return;
    }
    const event: NormalizedEvent = {
      surface: this.name,
      tenantId: tnt,
      conversationId: req.conversationId || sub,
      userId: sub,
      text: req.text,
      receivedAt: Date.now(),
    };
    try {
      for await (const text of this.opts.stream(event, signal)) {
        if (signal?.aborted) return;
        yield { kind: 'chunk', text };
      }
      yield { kind: 'done' };
    } catch (e) {
      yield { kind: 'error', message: (e as Error).message };
    }
  }
}

/** Canonical .proto definition. Generate stubs with protoc/buf. */
export const PROTO_SOURCE = `
syntax = "proto3";

package tenet.v1;

service TenetAgent {
  rpc Converse(ConverseRequest) returns (ConverseResponse);
  rpc ConverseStream(ConverseRequest) returns (stream ConverseChunk);
}

message ConverseRequest {
  string sub = 1;
  string tnt = 2;
  string conversation_id = 3;
  string text = 4;
}

message ConverseResponse {
  string reply = 1;
  string conversation_id = 2;
  repeated Citation citations = 3;
}

message Citation {
  string source_id = 1;
  string quote = 2;
}

message ConverseChunk {
  oneof body {
    string text = 1;
    bool done = 2;
    string error = 3;
  }
}
`.trim();

export const VERSION = '0.0.0';
