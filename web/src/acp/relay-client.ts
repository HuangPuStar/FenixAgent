import { ACPClient } from "./client";
import type { ACPSettings } from "./types";

/**
 * Build the RCS relay WebSocket URL for a given agent.
 * Uses cookie-based auth (better-auth session).
 */
export function buildRelayUrl(agentId: string, sessionId?: string): string {
  console.log('[RelayClient Debug] Building relay URL:', { agentId, sessionId, protocol: window.location.protocol, host: window.location.host });
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/acp/relay/${agentId}`;
  const url = sessionId ? `${base}?sessionId=${encodeURIComponent(sessionId)}` : base;
  console.log('[RelayClient Debug] Relay URL:', url);
  return url;
}

/**
 * Create an ACPClient that connects to an agent through the RCS relay.
 * The relay transparently forwards ACP protocol messages between
 * the frontend and the target acp-link instance.
 * Authentication is handled via cookies (better-auth session).
 */
export function createRelayClient(agentId: string, sessionId?: string): ACPClient {
  console.log('[RelayClient Debug] Creating relay client:', { agentId, sessionId });
  const relayUrl = buildRelayUrl(agentId, sessionId);
  const settings: ACPSettings = { proxyUrl: relayUrl };
  console.log('[RelayClient Debug] Relay settings:', settings);
  return new ACPClient(settings);
}
