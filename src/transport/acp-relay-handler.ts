import type { WSContext } from "hono/ws";
import {
  findAcpConnectionByAgentId,
  sendToAgentWs,
} from "./acp-ws-handler";
import { getAcpEventBus } from "./event-bus";
import type { SessionEvent } from "./event-bus";
import { storeGetEnvironment } from "../store";
import { findRunningInstanceByEnvironment } from "../services/instance";
import { log, error as logError } from "../logger";

// Per-relay connection state
interface RelayConnectionEntry {
  agentId: string;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WSContext;
  openTime: number;
  // Instance mode: direct WS to acp-link's local server
  localWs: WebSocket | null;
  // Message buffer while local WS is connecting
  pendingMessages: string[];
}

const relayConnections = new Map<string, RelayConnectionEntry>(); // key: relayWsId

const RELAY_KEEPALIVE_INTERVAL_MS = 20_000;

/** Send a JSON message to relay WS */
function sendToRelayWs(ws: WSContext, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    logError("[ACP-Relay] send error:", err);
  }
}

/** Called from onOpen — finds target agent and bridges connection */
export function handleRelayOpen(ws: WSContext, relayWsId: string, agentId: string, userId: string): void {
  log(`[ACP-Relay] Relay connection opened: relayWsId=${relayWsId} agentId=${agentId} userId=${userId}`);

  // Check for spawned instance — connect directly to acp-link's local WS
  const instance = findRunningInstanceByEnvironment(agentId);
  if (instance) {
    log(`[ACP-Relay] Found running instance for ${agentId}, connecting to local WS on port ${instance.port}`);
    openInstanceRelay(ws, relayWsId, agentId, userId, instance.port, instance.apiKey);
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
function openInstanceRelay(ws: WSContext, relayWsId: string, agentId: string, userId: string, port: number, token: string): void {
  const localWs = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`);

  const keepalive = setInterval(() => {
    const entry = relayConnections.get(relayWsId);
    if (!entry || entry.ws.readyState !== 1) {
      clearInterval(keepalive);
      return;
    }
    sendToRelayWs(entry.ws, { type: "keep_alive" });
  }, RELAY_KEEPALIVE_INTERVAL_MS);

  const entry: RelayConnectionEntry = {
    agentId,
    userId,
    unsub: null,
    keepalive,
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

  // Forward messages from acp-link → frontend
  localWs.onmessage = (event) => {
    if (ws.readyState !== 1) return;
    const text = typeof event.data === "string" ? event.data : String(event.data);
    for (const line of text.split("\n").filter((l: string) => l.trim())) {
      try {
        ws.send(line);
      } catch (err) {
        logError("[ACP-Relay] Error forwarding to frontend:", err);
      }
    }
  };

  localWs.onclose = (event) => {
    log(`[ACP-Relay] Local WS closed: code=${event.code} reason=${event.reason || "(none)"}`);
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
function openEventBusRelay(ws: WSContext, relayWsId: string, agentId: string, userId: string): void {
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
export function handleRelayMessage(ws: WSContext, relayWsId: string, data: string): void {
  const entry = relayConnections.get(relayWsId);
  if (!entry) return;

  // Instance mode: forward directly to acp-link's local WS
  if (entry.localWs) {
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
      const env = storeGetEnvironment(entry.agentId);
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
export function handleRelayClose(ws: WSContext, relayWsId: string, code?: number, reason?: string): void {
  const entry = relayConnections.get(relayWsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(`[ACP-Relay] Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? "none"} reason=${reason || "(none)"} duration=${duration}s`);

  if (entry.localWs) {
    try { entry.localWs.close(); } catch {}
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
  if (relayConnections.size === 0) return;

  log(`[ACP-Relay] Closing ${relayConnections.size} relay connection(s)...`);
  for (const [relayWsId, entry] of relayConnections) {
    try {
      if (entry.localWs) entry.localWs.close();
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
