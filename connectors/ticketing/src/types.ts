/**
 * Ticketing connector base types.
 *
 * Apps configure one or more TicketingConnector instances (per vendor +
 * per-tenant) and route inbound webhooks to verifyAndParse(), agent-
 * generated replies to postReply(). The shared TicketingEvent envelope
 * is consumed by the agent runtime; per-vendor specifics live behind
 * each factory.
 */

export interface TicketingEvent {
  /** Vendor name (zendesk, intercom, freshdesk, servicenow). */
  vendor: string;
  /** Stable tenant id resolved from the connector config. */
  tenantId: string;
  /** Conversation / ticket / case id at the vendor. */
  conversationId: string;
  /** Author id at the vendor (customer). */
  userId: string;
  /** Free-text body of the inbound message. */
  text: string;
  /** Wall-clock ms when the event was created at the vendor. */
  receivedAt: number;
  /** Free-form metadata for downstream telemetry. */
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface TicketingHttp {
  fetch(input: string, init: {
    method: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string> }>;
}

export interface TicketingConnector {
  vendor: string;
  /** Validate webhook signature and parse the body. */
  verifyAndParse(args: {
    body: string;
    headers: Readonly<Record<string, string | undefined>>;
    now?: number;
  }): TicketingEvent | null;
  /** Post a reply to a ticket conversation. */
  postReply(args: {
    conversationId: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export class TicketingSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketingSignatureError';
  }
}
