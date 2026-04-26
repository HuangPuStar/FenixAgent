import type { WSContext } from "hono/ws";
import { v4 as uuid } from "uuid";
import { getAcpEventBus } from "./event-bus";
import type { SessionEvent } from "./event-bus";
import {
  storeCreateEnvironment,
  storeCreateSession,
  storeDeleteEnvironment,
  storeGetEnvironment,
  storeListSessionsByEnvironment,
  storeUpdateEnvironment,
} from "../store";
import { config } from "../config";
import { log, error as logError } from "../logger";

// Per-connection state
interface AcpConnectionEntry {
  agentId: string | null; // Set after register message
  boundEnvId: string | null; // Set when connected via environment.secret
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WSContext;
  openTime: number;
  lastClientActivity: number;
  capabilities: Record<string, unknown> | null;
}

const connections = new Map<string, AcpConnectionEntry>(); // key: wsId

const SERVER_KEEPALIVE_INTERVAL_MS = config.wsKeepaliveInterval * 1000;
const CLIENT_ACTIVITY_TIMEOUT_MS = SERVER_KEEPALIVE_INTERVAL_MS * 3;

/** Send a JSON message to a WS connection (NDJSON format) */
function sendToWs(ws: WSContext, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg) + "\n");
  } catch (err) {
    logError("[ACP-WS] send error:", err);
  }
}

/** Called from onOpen — initializes connection tracking */
export function handleAcpWsOpen(ws: WSContext, wsId: string, userId: string, boundEnvId?: string | null): void {
  log(`[ACP-WS] Connection opened: wsId=${wsId} userId=${userId}${boundEnvId ? ` boundEnvId=${boundEnvId}` : ""}`);

  // If bound to a persistent environment, mark it active immediately
  if (boundEnvId) {
    storeUpdateEnvironment(boundEnvId, { status: "active", lastPollAt: new Date() });
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

  // If bound to a persistent environment, subscribe to EventBus immediately
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
function handleRegister(wsId: string, msg: Record<string, unknown>): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  if (entry.agentId) {
    // Already bound via environment.secret during WS upgrade — acknowledge silently
    if (entry.agentId === entry.boundEnvId) {
      log(`[ACP-WS] Register after bound: agentId=${entry.agentId}, acknowledging`);
      sendToWs(entry.ws, {
        type: "registered",
        agent_id: entry.agentId,
      });
      return;
    }
    sendToWs(entry.ws, { type: "error", message: "Already registered" });
    return;
  }

  const agentName = (msg.agent_name as string) || "unknown";
  const capabilities = msg.capabilities as Record<string, unknown> | undefined;
  const acpLinkVersion = (msg.acp_link_version as string) || null;
  const maxSessions = typeof msg.max_sessions === "number" ? msg.max_sessions : 1;

  // If already bound to a persistent environment via environment.secret
  if (entry.boundEnvId) {
    storeUpdateEnvironment(entry.boundEnvId, {
      status: "active",
      lastPollAt: new Date(),
      capabilities: capabilities || null,
      maxSessions,
    });

    entry.agentId = entry.boundEnvId;
    entry.capabilities = capabilities || null;

    // Auto-create session if none exists
    const existing = storeListSessionsByEnvironment(entry.boundEnvId);
    if (existing.length === 0) {
      storeCreateSession({
        environmentId: entry.boundEnvId,
        title: agentName || "ACP Agent",
        source: "acp",
        userId: entry.userId,
      });
    }

    log(`[ACP-WS] Bound agent registered: agentId=${entry.boundEnvId} userId=${entry.userId} name=${agentName}`);
    sendToWs(entry.ws, {
      type: "registered",
      agent_id: entry.boundEnvId,
    });
    return;
  }

  // Create new EnvironmentRecord (temporary, not bound to persistent env)
  const record = storeCreateEnvironment({
    secret: `ws_${wsId}`,
    userId: entry.userId,
    machineName: agentName,
    workerType: "acp",
    maxSessions,
    capabilities: capabilities || undefined,
  });

  // Auto-create session if none exists for this environment
  const existing = storeListSessionsByEnvironment(record.id);
  if (existing.length === 0) {
    storeCreateSession({
      environmentId: record.id,
      title: agentName || "ACP Agent",
      source: "acp",
      userId: entry.userId,
    });
  }

  entry.agentId = record.id;
  entry.capabilities = capabilities || null;

  // Subscribe to per-agent EventBus — broadcast events to this WS
  const bus = getAcpEventBus(record.id);
  const unsub = bus.subscribe((event: SessionEvent) => {
    if (entry.ws.readyState !== 1) return;
    if (event.direction !== "outbound") return;
    sendToWs(entry.ws, event.payload as object);
  });
  entry.unsub = unsub;

  log(`[ACP-WS] Agent registered: agentId=${record.id} userId=${entry.userId} name=${agentName}`);
  sendToWs(entry.ws, {
    type: "registered",
    agent_id: record.id,
  });
}

/** Handle identify message — binds WS to an existing agent registered via REST */
function handleIdentify(wsId: string, msg: Record<string, unknown>): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  if (entry.agentId) {
    // Already bound via environment.secret during WS upgrade — acknowledge silently
    if (entry.agentId === entry.boundEnvId) {
      log(`[ACP-WS] Identify after bound: agentId=${entry.agentId}, acknowledging`);
      sendToWs(entry.ws, {
        type: "identified",
        agent_id: entry.agentId,
      });
      return;
    }
    sendToWs(entry.ws, { type: "error", message: "Already identified" });
    return;
  }

  // If already bound via environment.secret, use the bound ID directly
  if (entry.boundEnvId) {
    storeUpdateEnvironment(entry.boundEnvId, { status: "active", lastPollAt: new Date() });

    const bus = getAcpEventBus(entry.boundEnvId);
    const unsub = bus.subscribe((event: SessionEvent) => {
      if (entry.ws.readyState !== 1) return;
      if (event.direction !== "outbound") return;
      sendToWs(entry.ws, event.payload as object);
    });
    entry.unsub = unsub;

    log(`[ACP-WS] Bound agent identified: agentId=${entry.boundEnvId} userId=${entry.userId}`);
    sendToWs(entry.ws, {
      type: "identified",
      agent_id: entry.boundEnvId,
    });
    return;
  }

  const agentId = msg.agent_id as string;
  if (!agentId) {
    sendToWs(entry.ws, { type: "error", message: "Missing agent_id" });
    return;
  }

  // Look up the environment record
  const record = storeGetEnvironment(agentId);
  if (!record || record.workerType !== "acp") {
    sendToWs(entry.ws, { type: "error", message: "Agent not found" });
    return;
  }

  // Verify ownership
  if (record.userId && record.userId !== entry.userId) {
    sendToWs(entry.ws, { type: "error", message: "Agent not owned by you" });
    return;
  }

  // Update status to active
  storeUpdateEnvironment(agentId, { status: "active", lastPollAt: new Date() });

  entry.agentId = record.id;
  entry.capabilities = record.capabilities || null;

  // Subscribe to per-agent EventBus
  const bus = getAcpEventBus(record.id);
  const unsub = bus.subscribe((event: SessionEvent) => {
    if (entry.ws.readyState !== 1) return;
    if (event.direction !== "outbound") return;
    sendToWs(entry.ws, event.payload as object);
  });
  entry.unsub = unsub;

  log(`[ACP-WS] Agent identified: agentId=${record.id} userId=${entry.userId}`);
  sendToWs(entry.ws, {
    type: "identified",
    agent_id: record.id,
  });
}

/** Called from onMessage — processes NDJSON lines */
export function handleAcpWsMessage(ws: WSContext, wsId: string, data: string): void {
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

    // Handle keepalive
    if (msg.type === "keep_alive") {
      if (entry.agentId) {
        storeUpdateEnvironment(entry.agentId, { lastPollAt: new Date() });
      }
      continue;
    }

    // Handle registration
    if (msg.type === "register") {
      handleRegister(wsId, msg);
      continue;
    }

    // Handle identify (REST registration + WS binding)
    if (msg.type === "identify") {
      handleIdentify(wsId, msg);
      continue;
    }

    // Not registered yet — reject
    if (!entry.agentId) {
      sendToWs(entry.ws, { type: "error", message: "Not registered. Send register message first." });
      continue;
    }

    // Update agent activity
    storeUpdateEnvironment(entry.agentId, { lastPollAt: new Date() });

    // Pass-through: publish to per-agent EventBus as inbound
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
export function handleAcpWsClose(ws: WSContext, wsId: string, code?: number, reason?: string): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(`[ACP-WS] Connection closed: wsId=${wsId} agentId=${entry.agentId} code=${code ?? "none"} reason=${reason || "(none)"} duration=${duration}s`);

  if (entry.unsub) {
    entry.unsub();
  }
  if (entry.keepalive) {
    clearInterval(entry.keepalive);
  }

  // Handle agent record cleanup based on binding type
  if (entry.agentId) {
    if (entry.boundEnvId) {
      // Persistent environment: update status to idle, don't delete
      storeUpdateEnvironment(entry.agentId, { status: "idle" });
    } else {
      // Temporary environment: delete record and associated sessions
      storeDeleteEnvironment(entry.agentId);
    }

    // Notify all relay connections that this agent is gone
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
        if (entry.boundEnvId) {
          storeUpdateEnvironment(entry.agentId, { status: "idle" });
        } else {
          storeDeleteEnvironment(entry.agentId);
        }
      }
    } catch {
      // ignore errors during shutdown
    }
  }
  connections.clear();
  log("[ACP-WS] All connections closed");
}
