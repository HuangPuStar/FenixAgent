/**
 * Minimal WebSocket connection abstraction.
 * Decouples transport handlers from framework-specific WS types (Hono WSContext, Elysia WS).
 */
export interface WsConnection {
  /** Send text data to the client */
  send(data: string): void;
  /** Close the connection with a code and optional reason */
  close(code?: number, reason?: string): void;
  /** Current ready state (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED) */
  readonly readyState: number;
}
