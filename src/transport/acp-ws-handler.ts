import type { WsConnection } from "./ws-types";
import { v4 as uuid } from "uuid";
import { getAcpEventBus } from "./event-bus";
import type { SessionEvent } from "./event-bus";
import {
  handleAcpConnect,
  handleAcpRegister,
  handleAcpIdentify,
  handleAcpDisconnect,
  touchEnvironmentPoll,
} from "../services/environment";
import { config } from "../config";
import { log, error as logError } from "../logger";

// Per-connection state
interface AcpConnectionEntry {
  agentId: string | null;
  boundEnvId: string | null;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WsConnection;
  openTime: number;
  lastClientActivity: number;
  capabilities: Record<string, unknown> | null;
}

const connections = new Map<string, AcpConnectionEntry>();

const SERVER_KEEPALIVE_INTERVAL_MS = config.wsKeepaliveInterval * 1000;
const CLIENT_ACTIVITY_TIMEOUT_MS = SERVER_KEEPALIVE_INTERVAL_MS * 3;

function sendToWs(ws: WsConnection, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg) + "\n");
  } catch (err) {
    logError("[ACP-WS] send error:", err);
  }
}

/** Called from onOpen — initializes connection tracking */
export function handleAcpWsOpen(ws: WsConnection, wsId: string, userId: string, boundEnvId?: string | null): void {
  log(`[ACP-WS] Connection opened: wsId=${wsId} userId=${userId}${boundEnvId ? ` boundEnvId=${boundEnvId}` : ""}`);

  if (boundEnvId) {
    handleAcpConnect(boundEnvId).catch(() => {});
  }

  const keepalive = setInterval(() => {
    const entry = connections.get(wsId);
    if (!entry || entry.ws.readyState !== 1) {
      clearInterval(keepalive);
      return;
    }
    const silenceMs = Date.now() - entry.lastClientActivity;
    if (silenceMs > CLIENT_ACTIVITY_TIMEOUT_MS) {
      log(`[ACP-WS] Client inactive for ${Math.round(silenceMs / 1000)}s, closing dead connection`);
      try {
        entry.ws.close(1000, "client inactive");
      } catch {
        clearInterval(keepalive);
      }
      return;
    }
    sendToWs(entry.ws, { type: "keep_alive" });
  }, SERVER_KEEPALIVE_INTERVAL_MS);

  connections.set(wsId, {
    agentId: boundEnvId || null,
    boundEnvId: boundEnvId || null,
    userId,
    unsub: null,
    keepalive,
    ws,
    openTime: Date.now(),
    lastClientActivity: Date.now(),
    capabilities: null,
  });

  if (boundEnvId) {
    const bus = getAcpEventBus(boundEnvId);
    const unsub = bus.subscribe((event: SessionEvent) => {
      const entry = connections.get(wsId);
      if (!entry || entry.ws.readyState !== 1) return;
      if (event.direction !== "outbound") return;
      sendToWs(entry.ws, event.payload as object);
    });
    const entry = connections.get(wsId);
    if (entry) entry.unsub = unsub;
  }
}

/** Handle register message — WS registration for ACP agent */
async function handleRegister(wsId: string, msg: Record<string, unknown>): Promise<void> {
  const entry = connections.get(wsId);
  if (!entry) return;

  if (entry.agentId) {
    if (entry.agentId === entry.boundEnvId) {
      log(`[ACP-WS] Register after bound: agentId=${entry.agentId}, acknowledging`);
      sendToWs(entry.ws, { type: "registered", agent_id: entry.agentId });
      return;
    }
    sendToWs(entry.ws, { type: "error", message: "Already registered" });
    return;
  }

  const agentName = (msg.agent_name as string) || "unknown";
  const capabilities = msg.capabilities as Record<string, unknown> | undefined;
  const maxSessions = typeof msg.max_sessions === "number" ? msg.max_sessions : 1;
  const directory = (msg.directory as string) || undefined;

  try {
    const result = await handleAcpRegister({
      wsId,
      userId: entry.userId,
      agentName,
      capabilities,
      maxSessions,
      directory,
      boundEnvId: entry.boundEnvId,
    });

    entry.agentId = result.envId;
    entry.capabilities = capabilities || null;

    // unbound 环境需要新建 EventBus 订阅；bound 环境在 onOpen 时已订阅
    if (result.isNew) {
      const bus = getAcpEventBus(result.envId);
      const unsub = bus.subscribe((event: SessionEvent) => {
        if (entry.ws.readyState !== 1) return;
        if (event.direction !== "outbound") return;
        sendToWs(entry.ws, event.payload as object);
      });
      entry.unsub = unsub;
    }

    log(`[ACP-WS] ${result.isNew ? "Agent registered" : "Bound agent registered"}: agentId=${result.envId} userId=${entry.userId} name=${agentName}`);
    sendToWs(entry.ws, { type: "registered", agent_id: result.envId });
  } catch (err) {
    logError("[ACP-WS] Error in register handler:", err);
    sendToWs(entry.ws, { type: "error", message: "Registration failed" });
  }
}

/** Handle identify message — binds WS to an existing agent registered via REST */
async function handleIdentify(wsId: string, msg: Record<string, unknown>): Promise<void> {
  const entry = connections.get(wsId);
  if (!entry) return;

  if (entry.agentId) {
    if (entry.agentId === entry.boundEnvId) {
      log(`[ACP-WS] Identify after bound: agentId=${entry.agentId}, acknowledging`);
      sendToWs(entry.ws, { type: "identified", agent_id: entry.agentId });
      return;
    }
    sendToWs(entry.ws, { type: "error", message: "Already identified" });
    return;
  }

  // unbound 情况下必须提供 agent_id
  const agentId = (msg.agent_id as string) || "";
  if (!entry.boundEnvId && !agentId) {
    sendToWs(entry.ws, { type: "error", message: "Missing agent_id" });
    return;
  }

  try {
    const result = await handleAcpIdentify({
      agentId,
      userId: entry.userId,
      boundEnvId: entry.boundEnvId,
    });

    entry.agentId = result.envId;
    entry.capabilities = result.capabilities;

    // bound 环境在 onOpen 时未订阅（identify 场景需要单独订阅）
    if (entry.boundEnvId && !entry.unsub) {
      const bus = getAcpEventBus(entry.boundEnvId);
      const unsub = bus.subscribe((event: SessionEvent) => {
        if (entry.ws.readyState !== 1) return;
        if (event.direction !== "outbound") return;
        sendToWs(entry.ws, event.payload as object);
      });
      entry.unsub = unsub;
    } else if (!entry.boundEnvId) {
      const bus = getAcpEventBus(result.envId);
      const unsub = bus.subscribe((event: SessionEvent) => {
        if (entry.ws.readyState !== 1) return;
        if (event.direction !== "outbound") return;
        sendToWs(entry.ws, event.payload as object);
      });
      entry.unsub = unsub;
    }

    log(`[ACP-WS] ${entry.boundEnvId ? "Bound agent identified" : "Agent identified"}: agentId=${result.envId} userId=${entry.userId}`);
    sendToWs(entry.ws, { type: "identified", agent_id: result.envId });
  } catch (err: any) {
    logError("[ACP-WS] Error in identify handler:", err);
    const message = err.code === "NOT_FOUND" ? "Agent not found"
      : err.code === "FORBIDDEN" ? "Agent not owned by you"
      : "Identification failed";
    sendToWs(entry.ws, { type: "error", message });
  }
}

/** Called from onMessage — processes NDJSON lines */
export function handleAcpWsMessage(ws: WsConnection, wsId: string, data: string): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  entry.lastClientActivity = Date.now();

  const lines = data.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      logError("[ACP-WS] parse error:", line);
      continue;
    }

    if (msg.type === "keep_alive") {
      if (entry.agentId) {
        touchEnvironmentPoll(entry.agentId).catch(() => {});
      }
      continue;
    }

    if (msg.type === "register") {
      handleRegister(wsId, msg).catch((err) => {
        logError("[ACP-WS] Error in register handler:", err);
      });
      continue;
    }

    if (msg.type === "identify") {
      handleIdentify(wsId, msg).catch((err) => {
        logError("[ACP-WS] Error in identify handler:", err);
      });
      continue;
    }

    if (!entry.agentId) {
      sendToWs(entry.ws, { type: "error", message: "Not registered. Send register message first." });
      continue;
    }

    touchEnvironmentPoll(entry.agentId).catch(() => {});

    const bus = getAcpEventBus(entry.agentId);
    bus.publish({
      id: uuid(),
      sessionId: entry.agentId,
      type: (msg.type as string) || "acp_message",
      payload: msg,
      direction: "inbound",
    });
  }
}

/** Called from onClose — marks agent offline and cleans up */
export function handleAcpWsClose(ws: WsConnection, wsId: string, code?: number, reason?: string): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(`[ACP-WS] Connection closed: wsId=${wsId} agentId=${entry.agentId} code=${code ?? "none"} reason=${reason || "(none)"} duration=${duration}s`);

  if (entry.unsub) entry.unsub();
  if (entry.keepalive) clearInterval(entry.keepalive);

  if (entry.agentId) {
    handleAcpDisconnect(entry.agentId, !!entry.boundEnvId).catch(() => {});

    const bus = getAcpEventBus(entry.agentId);
    bus.publish({
      id: uuid(),
      sessionId: entry.agentId,
      type: "agent_disconnect",
      payload: { agentId: entry.agentId },
      direction: "inbound",
    });
  }

  connections.delete(wsId);
}

/** Find an active ACP connection by agent ID */
export function findAcpConnectionByAgentId(agentId: string): AcpConnectionEntry | null {
  for (const entry of connections.values()) {
    if (entry.agentId === agentId && entry.ws.readyState === 1) {
      return entry;
    }
  }
  return null;
}

/** Send a JSON message directly to an agent's WebSocket connection */
export function sendToAgentWs(agentId: string, msg: object): boolean {
  const entry = findAcpConnectionByAgentId(agentId);
  if (!entry) return false;
  sendToWs(entry.ws, msg);
  return true;
}

/** Gracefully close all ACP WebSocket connections */
export function closeAllAcpConnections(): void {
  if (connections.size === 0) return;

  log(`[ACP-WS] Gracefully closing ${connections.size} ACP connection(s)...`);
  for (const [wsId, entry] of connections) {
    try {
      if (entry.unsub) entry.unsub();
      if (entry.keepalive) clearInterval(entry.keepalive);
      if (entry.ws.readyState === 1) {
        entry.ws.close(1001, "server_shutdown");
      }
      if (entry.agentId) {
        handleAcpDisconnect(entry.agentId, !!entry.boundEnvId).catch(() => {});
      }
    } catch {
      // ignore errors during shutdown
    }
  }
  connections.clear();
  log("[ACP-WS] All connections closed");
}
