import type { WsConnection } from "./ws-types";
import {
  findAcpConnectionByAgentId,
  sendToAgentWs,
} from "./acp-ws-handler";
import { getAcpEventBus } from "./event-bus";
import type { SessionEvent } from "./event-bus";
import { environmentRepo } from "../repositories";
import { findRunningInstanceByEnvironment, findInstanceBySessionId } from "../services/instance";
import { log, error as logError } from "../logger";

// Per-relay connection state
interface RelayConnectionEntry {
  agentId: string;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WsConnection;
  openTime: number;
  // Instance mode: direct WS to acp-link's local server
  localWs: WebSocket | null;
  // Message buffer while local WS is connecting
  pendingMessages: string[];
}

const relayConnections = new Map<string, RelayConnectionEntry>(); // key: relayWsId

// Track the current localWs per agent so we can reuse/replace on reconnect
// Includes a keep_alive interval to keep acp-link alive even when no relay is connected.
interface AgentLocalConn {
  ws: WebSocket;
  keepalive: ReturnType<typeof setInterval>;
  agentId: string;
}
const agentLocalWsMap = new Map<string, AgentLocalConn>(); // instanceId → localWs + keepalive + agentId

const RELAY_KEEPALIVE_INTERVAL_MS = 20_000;
const INSTANCE_LOCAL_WS_HOST = "127.0.0.1";

/** Publish local WS messages to the ACP EventBus so hermes-client and other subscribers can receive them. */
function publishLocalWsToEventBus(agentId: string, text: string): void {
  const bus = getAcpEventBus(agentId);
  for (const line of text.split("\n").filter((l) => l.trim())) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "keep_alive" || msg.type === "pong") continue;
      // Derive event type: explicit type field, or message.role for stream-json format
      let eventType = typeof msg.type === "string" ? msg.type : "";
      if (!eventType) {
        const message = msg.message as Record<string, unknown> | undefined;
        if (message && typeof message.role === "string") {
          eventType = message.role; // "user", "assistant", "system"
        }
      }
      if (!eventType) eventType = "acp_message";
      bus.publish({
        id: crypto.randomUUID(),
        sessionId: agentId,
        type: eventType,
        payload: msg,
        direction: "inbound",
      });
    } catch (e) {
      logError(`[ACP-Relay] localWs→EventBus: JSON parse failed: ${line.slice(0, 200)}`);
    }
  }
}

/**
 * Filter and forward lines from acp-link to the frontend.
 * Skips keep_alive messages and errors caused by keep_alive.
 */
function forwardFilteredLines(text: string, send: (line: string) => void): void {
  for (const line of text.split("\n").filter((l: string) => l.trim())) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "keep_alive" || msg.type === "pong") continue;
      const errMsg = typeof msg.message === "string"
        ? msg.message
        : typeof msg.payload?.message === "string"
          ? msg.payload.message
          : null;
      if (msg.type === "error" && errMsg?.includes("keep_alive")) continue;
      send(line);
    } catch (err) {
      logError("[ACP-Relay] Error forwarding to frontend:", err);
    }
  }
}

/** Send a JSON message to relay WS */
function sendToRelayWs(ws: WsConnection, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    logError("[ACP-Relay] send error:", err);
  }
}

/** Called from onOpen — finds target agent and bridges connection */
export function handleRelayOpen(ws: WsConnection, relayWsId: string, agentId: string, userId: string, sessionId?: string): void {
  log(`[ACP-Relay] Relay connection opened: relayWsId=${relayWsId} agentId=${agentId} userId=${userId} sessionId=${sessionId ?? "(none)"}`);

  // Check for spawned instance — prefer instance matching the sessionId
  let instance = sessionId ? findInstanceBySessionId(sessionId) : undefined;
  if (!instance) {
    instance = findRunningInstanceByEnvironment(agentId);
  }
  if (instance) {
    log(`[ACP-Relay] Found instance ${instance.id} for ${agentId} (session=${sessionId ?? "any"}), connecting to local WS on port ${instance.port}`);
    openInstanceRelay(ws, relayWsId, agentId, userId, instance);
    return;
  }

  // Fallback: EventBus-based relay for direct acp-link WS connections
  const agentConn = findAcpConnectionByAgentId(agentId);
  if (!agentConn) {
    log(`[ACP-Relay] Agent ${agentId} not found or offline`);
    sendToRelayWs(ws, { type: "error", message: "Agent not found or offline" });
    ws.close(4004, "agent not found");
    return;
  }

  openEventBusRelay(ws, relayWsId, agentId, userId);
}

/** Instance mode: open direct WS to acp-link's local server */
function openInstanceRelay(ws: WsConnection, relayWsId: string, agentId: string, userId: string, instance: import("../services/instance").SpawnedInstance): void {
  const instanceId = instance.id;
  const port = instance.port;
  const token = instance.apiKey;
  // Relay keepalive — only runs while relay is alive
  const relayKeepalive = setInterval(() => {
    const entry = relayConnections.get(relayWsId);
    if (!entry || entry.ws.readyState !== 1) {
      clearInterval(relayKeepalive);
      return;
    }
    sendToRelayWs(entry.ws, { type: "keep_alive" });
  }, RELAY_KEEPALIVE_INTERVAL_MS);

  // Reuse existing local WS if available and still connected
  const existingConn = agentLocalWsMap.get(instanceId);
  if (existingConn && existingConn.ws.readyState === 1) {
    log(`[ACP-Relay] Reusing existing local WS for instance ${instanceId}`);

    const entry: RelayConnectionEntry = {
      agentId,
      userId,
      unsub: null,
      keepalive: relayKeepalive,
      ws,
      openTime: Date.now(),
      localWs: existingConn.ws,
      pendingMessages: [],
    };
    relayConnections.set(relayWsId, entry);

    // Retarget message forwarding to the new relay WS + publish to EventBus
    existingConn.ws.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      publishLocalWsToEventBus(agentId, text);
      if (ws.readyState !== 1) return;
      forwardFilteredLines(text, (line) => ws.send(line));
    };

    // Notify frontend that agent is connected
    sendToRelayWs(ws, { type: "status", payload: { connected: true } });
    return;
  }

  // No existing connection — clean up stale entry if any, then create new
  if (existingConn) {
    clearInterval(existingConn.keepalive);
    try { existingConn.ws.close(); } catch {}
    agentLocalWsMap.delete(instanceId);
  }

  const localWs = new WebSocket(`ws://${INSTANCE_LOCAL_WS_HOST}:${port}/ws?token=${encodeURIComponent(token)}`);

  // Independent keep_alive to acp-link — runs even when no relay is connected
  // Use "ping" (ACP protocol) instead of "keep_alive" which acp-link doesn't understand
  const localKeepalive = setInterval(() => {
    if (localWs.readyState === 1) {
      localWs.send(JSON.stringify({ type: "ping" }));
    }
  }, RELAY_KEEPALIVE_INTERVAL_MS);

  agentLocalWsMap.set(instanceId, { ws: localWs, keepalive: localKeepalive, agentId });

  const entry: RelayConnectionEntry = {
    agentId,
    userId,
    unsub: null,
    keepalive: relayKeepalive,
    ws,
    openTime: Date.now(),
    localWs,
    pendingMessages: [],
  };
  relayConnections.set(relayWsId, entry);

  localWs.onopen = () => {
    log(`[ACP-Relay] Local WS connected to acp-link on port ${port}`);
    // Flush pending messages
    const e = relayConnections.get(relayWsId);
    if (e && e.localWs) {
      for (const msg of e.pendingMessages) {
        try { e.localWs.send(msg); } catch {}
      }
      e.pendingMessages = [];
    }
  };

  // Forward messages from acp-link → frontend + publish to EventBus
  localWs.onmessage = (event) => {
    const text = typeof event.data === "string" ? event.data : String(event.data);
    publishLocalWsToEventBus(agentId, text);
    if (ws.readyState !== 1) return;
    forwardFilteredLines(text, (line) => ws.send(line));
  };

  localWs.onclose = (event) => {
    log(`[ACP-Relay] Local WS closed: code=${event.code} reason=${event.reason || "(none)"}`);
    // Clean up shared connection
    const conn = agentLocalWsMap.get(instanceId);
    if (conn && conn.ws === localWs) {
      clearInterval(conn.keepalive);
      agentLocalWsMap.delete(instanceId);
    }
    if (ws.readyState === 1) {
      sendToRelayWs(ws, { type: "status", payload: { connected: false } });
    }
  };

  localWs.onerror = () => {
    logError(`[ACP-Relay] Local WS error`);
    if (ws.readyState === 1) {
      sendToRelayWs(ws, { type: "error", message: "Agent connection error" });
      ws.close(1011, "agent connection error");
    }
  };
}

/** EventBus mode: for direct acp-link WS connections */
function openEventBusRelay(ws: WsConnection, relayWsId: string, agentId: string, userId: string): void {
  const keepalive = setInterval(() => {
    const entry = relayConnections.get(relayWsId);
    if (!entry || entry.ws.readyState !== 1) {
      clearInterval(keepalive);
      return;
    }
    sendToRelayWs(entry.ws, { type: "keep_alive" });
  }, RELAY_KEEPALIVE_INTERVAL_MS);

  const bus = getAcpEventBus(agentId);
  const unsub = bus.subscribe((event: SessionEvent) => {
    if (ws.readyState !== 1) return;
    if (event.direction !== "inbound") return;
    if (event.type === "agent_disconnect") {
      sendToRelayWs(ws, { type: "status", payload: { connected: false } });
      return;
    }
    sendToRelayWs(ws, event.payload as object);
  });

  relayConnections.set(relayWsId, {
    agentId,
    userId,
    unsub,
    keepalive,
    ws,
    openTime: Date.now(),
    localWs: null,
    pendingMessages: [],
  });

  log(`[ACP-Relay] EventBus relay established: relayWsId=${relayWsId} → agentId=${agentId}`);
}

/** Called from onMessage — forwards frontend messages */
export async function handleRelayMessage(ws: WsConnection, relayWsId: string, data: string): Promise<void> {
  const entry = relayConnections.get(relayWsId);
  if (!entry) return;

  // Instance mode: forward directly to acp-link's local WS
  if (entry.localWs) {
    // Intercept frontend ping — reply pong directly (acp-link's pong is filtered by forwardFilteredLines)
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === "ping") {
        sendToRelayWs(ws, { type: "pong" });
        return;
      }
    } catch {}
    if (entry.localWs.readyState === 1) { // WebSocket.OPEN
      entry.localWs.send(data);
    } else {
      // Buffer until local WS is open
      entry.pendingMessages.push(data);
    }
    return;
  }

  // EventBus mode: handle control messages and forward
  const lines = data.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      logError("[ACP-Relay] parse error:", line);
      continue;
    }

    if (msg.type === "keep_alive") continue;

    if (msg.type === "ping") {
      sendToRelayWs(ws, { type: "pong" });
      continue;
    }

    if (msg.type === "connect") {
      const env = await environmentRepo.getById(entry.agentId);
      sendToRelayWs(ws, {
        type: "status",
        payload: { connected: true, capabilities: env?.capabilities ?? null },
      });
      continue;
    }

    const sent = sendToAgentWs(entry.agentId, msg);
    if (!sent) {
      sendToRelayWs(ws, { type: "error", message: "Agent connection lost" });
      return;
    }
  }
}

/** Called from onClose — cleans up relay connection */
export function handleRelayClose(ws: WsConnection, relayWsId: string, code?: number, reason?: string): void {
  const entry = relayConnections.get(relayWsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(`[ACP-Relay] Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? "none"} reason=${reason || "(none)"} duration=${duration}s`);

  if (entry.localWs) {
    // Don't close localWs — keep acp-link process alive for reconnection.
    // Only the explicit stop-instance action should kill the process.
    // Keep EventBus publishing active (for hermes-client), just stop relay forwarding.
    entry.localWs.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      publishLocalWsToEventBus(entry.agentId, text);
    };
    // Retain onclose/onerror so we can detect acp-link crashes.
    entry.localWs = null;
  }
  if (entry.unsub) {
    entry.unsub();
  }
  if (entry.keepalive) {
    clearInterval(entry.keepalive);
  }

  relayConnections.delete(relayWsId);
}

/** Close all relay connections (for graceful shutdown) */
export function closeAllRelayConnections(): void {
  // Close shared local WS connections to instances
  for (const [agentId, conn] of agentLocalWsMap) {
    clearInterval(conn.keepalive);
    try { conn.ws.close(); } catch {}
  }
  agentLocalWsMap.clear();

  if (relayConnections.size === 0) return;

  log(`[ACP-Relay] Closing ${relayConnections.size} relay connection(s)...`);
  for (const [relayWsId, entry] of relayConnections) {
    try {
      if (entry.localWs) {
        entry.localWs.onmessage = null;
      }
      if (entry.unsub) entry.unsub();
      if (entry.keepalive) clearInterval(entry.keepalive);
      if (entry.ws.readyState === 1) {
        entry.ws.close(1001, "server_shutdown");
      }
    } catch {
      // ignore errors during shutdown
    }
  }
  relayConnections.clear();
  log("[ACP-Relay] All connections closed");
}

/** Send data to a spawned instance's local WS. Returns true if sent, false if not connected. */
export function sendToInstanceLocalWs(instanceId: string, data: string): boolean {
  const conn = agentLocalWsMap.get(instanceId);
  if (!conn || conn.ws.readyState !== 1) return false;
  try {
    conn.ws.send(data);
    return true;
  } catch {
    return false;
  }
}

/** Close the shared local WS for a specific instance (called when instance is stopped) */
export function closeInstanceLocalWs(instanceId: string): void {
  const conn = agentLocalWsMap.get(instanceId);
  if (conn) {
    clearInterval(conn.keepalive);
    try { conn.ws.close(); } catch {}
    agentLocalWsMap.delete(instanceId);
    log(`[ACP-Relay] Closed local WS for instance ${instanceId}`);
  }
}
