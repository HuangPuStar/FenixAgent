/**
 * Minimal WebSocket connection abstraction.
 * Decouples transport handlers from framework-specific WS types (Hono WSContext, Elysia WS).
 */
export interface WsConnection {
  /**
   * Send data to the client: JSON text frames (control messages) or binary
   * frames (Uint8Array, yjs:update wire protocol). Text-only endpoints ignore
   * the binary variant.
   */
  send(data: string | Uint8Array): void;
  /** Close the connection with a code and optional reason */
  close(code?: number, reason?: string): void;
  /** Current ready state (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED) */
  readonly readyState: number;
  /**
   * Unsent buffered bytes, when the adapter exposes it (Bun ServerWebSocket via
   * getBufferedAmount). Backpressure decisions (64KB threshold) read this;
   * adapters without support are treated as 0 (never congested).
   */
  readonly bufferedAmount?: number;
}
