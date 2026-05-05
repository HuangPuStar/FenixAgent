export const config = {
  version: process.env.RCS_VERSION || "0.1.0",
  port: parseInt(process.env.RCS_PORT || "3000"),
  host: process.env.RCS_HOST || "0.0.0.0",
  baseUrl: process.env.RCS_BASE_URL || "",
  /** Legacy global API keys (RCS_API_KEYS env). Supported for backward compatibility
   *  with acp-link's ACP_RCS_TOKEN. Per-user API keys in SQLite take priority. */
  apiKeys: (process.env.RCS_API_KEYS || "").split(",").filter(Boolean),
  pollTimeout: parseInt(process.env.RCS_POLL_TIMEOUT || "8"),
  heartbeatInterval: parseInt(process.env.RCS_HEARTBEAT_INTERVAL || "20"),
  /** Bun WebSocket idle timeout (seconds). Bun sends protocol-level pings after
   *  this many seconds of no received data. Set higher than
   *  wsKeepaliveInterval * 3 so that application-level keepalive detects dead
   *  connections before Bun closes them. Default 255s (Bun's built-in default). */
  wsIdleTimeout: parseInt(process.env.RCS_WS_IDLE_TIMEOUT || "255"),
  /** Server→client keep_alive data-frame interval (seconds). Keeps reverse
   *  proxies from closing idle connections. Default 20s. */
  wsKeepaliveInterval: parseInt(process.env.RCS_WS_KEEPALIVE_INTERVAL || "20"),
  /** Disconnect timeout (seconds). Environments/sessions with no activity for
   *  this long are considered disconnected. Default 120s. */
  disconnectTimeout: parseInt(process.env.RCS_DISCONNECT_TIMEOUT || "120"),
  /** JWT expiration time in seconds for worker tokens. Default 3600s (1 hour). */
  jwtExpiresIn: parseInt(process.env.RCS_JWT_EXPIRES_IN || "3600"),
  /** acpx-g workflow engine URL for reverse proxy. */
  acpxGUrl: process.env.ACPX_G_URL || "http://localhost:8848",
} as const;

export function getBaseUrl(): string {
  const url = config.baseUrl || `http://localhost:${config.port}`;
  return url.replace(/\/+$/, "");
}
