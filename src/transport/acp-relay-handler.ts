import type { WsConnection } from "./ws-types";
import {
  findAcpConnectionByAgentId,
  sendToAgentWs,
} from "./acp-ws-handler";
import { getAcpEventBus } from "./event-bus";
import type { SessionEvent } from "./event-bus";

import { findRunningInstanceByEnvironment, findInstanceBySessionId } from "../services/instance";
import { getCoreRuntime } from "../services/core-bootstrap";
import { log, error as logError } from "../logger";
import type { EngineRelayHandle } from "@mothership/plugin-sdk";

// Per-relay connection state
interface RelayConnectionEntry {
  agentId: string;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WsConnection;
  openTime: number;
  // Instance mode: core relay handle
  instanceId: string | null;
  relayHandle: EngineRelayHandle | null;
  relayUnsub: (() => void) | null;
  // Buffer for outbound messages arriving before relay handle is ready
  outboundBuffer: Record<string, unknown>[];
}

const relayConnections = new Map<string, RelayConnectionEntry>();
let isShuttingDown = false;

const RELAY_KEEPALIVE_INTERVAL_MS = 20_000;

/** Send a JSON message to relay WS */
function sendToRelayWs(ws: WsConnection, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    const payload = JSON.stringify(msg);
    ws.send(payload);
    log(`[ACP-Relay] Sent to frontend: type=${(msg as any).type} bytes=${payload.length}`);
  } catch (err) {
    logError("[ACP-Relay] send error:", err);
  }
}

/** Publish relay messages to the ACP EventBus for SSE subscribers. */
function publishToEventBus(agentId: string, message: Record<string, unknown>): void {
  const bus = getAcpEventBus(agentId);
  let eventType = typeof message.type === "string" ? message.type : "";
  if (!eventType) {
    const msg = message.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.role === "string") {
      eventType = msg.role;
    }
  }
  if (!eventType) eventType = "acp_message";
  bus.publish({
    id: crypto.randomUUID(),
    sessionId: agentId,
    type: eventType,
    payload: message,
    direction: "inbound",
  });
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
    log(`[ACP-Relay] Found instance ${instance.id} for ${agentId} (session=${sessionId ?? "any"}), opening core relay`);
    openInstanceRelay(ws, relayWsId, agentId, userId, instance.id);
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

/** Instance mode: use core's connectInstanceRelay for managed WS */
function openInstanceRelay(ws: WsConnection, relayWsId: string, agentId: string, userId: string, instanceId: string): void {
  // Relay keepalive to frontend — only runs while relay is alive
  const relayKeepalive = setInterval(() => {
    const entry = relayConnections.get(relayWsId);
    if (!entry || entry.ws.readyState !== 1) {
      clearInterval(relayKeepalive);
      return;
    }
    sendToRelayWs(entry.ws, { type: "keep_alive" });
  }, RELAY_KEEPALIVE_INTERVAL_MS);

  const entry: RelayConnectionEntry = {
    agentId,
    userId,
    unsub: null,
    keepalive: relayKeepalive,
    ws,
    openTime: Date.now(),
    instanceId,
    relayHandle: null,
    relayUnsub: null,
    outboundBuffer: [],
  };
  relayConnections.set(relayWsId, entry);

  // Asynchronously connect via core's relay
  const facade = getCoreRuntime();
  facade.connectInstanceRelay({
    instanceId,
    sessionId: relayWsId,
  }).then((handle) => {
    // Check if relay WS is still open
    if (ws.readyState !== 1) {
      handle.close();
      return;
    }

    entry.relayHandle = handle;

    // Flush buffered outbound messages (e.g. frontend's "connect" sent before relay was ready)
    if (entry.outboundBuffer.length > 0) {
      const buffered = entry.outboundBuffer.splice(0);
      log(`[ACP-Relay] Flushing ${buffered.length} buffered outbound messages for instance ${instanceId}`);
      for (const msg of buffered) {
        if (msg.type === "connect") {
          // Relay handle already sent connect; skip
          log("[ACP-Relay] Skipping buffered connect (relay handle auto-connects)");
          continue;
        }
        try {
          handle.send(msg as any);
        } catch {
          // relay closed during flush — stop
          break;
        }
      }
    }

    // Subscribe to inbound messages from engine
    if ("onMessage" in handle && typeof (handle as any).onMessage === "function") {
      const opencodeHandle = handle as { onMessage: (listener: (msg: any) => void) => () => void };
      entry.relayUnsub = opencodeHandle.onMessage((message) => {
        log(`[ACP-Relay] Forwarding to frontend: type=${(message as any).type} readyState=${ws.readyState}`);
        publishToEventBus(agentId, message);
        if (ws.readyState === 1) {
          sendToRelayWs(ws, message);
        } else {
          log(`[ACP-Relay] Frontend WS not open (state=${ws.readyState}), dropping message type=${(message as any).type}`);
        }
      });
      log(`[ACP-Relay] onMessage listener registered for instance ${instanceId}`);
    } else {
      logError(`[ACP-Relay] Relay handle missing onMessage for instance ${instanceId}, handle keys: ${Object.keys(handle).join(",")}`);
    }

    // 不再主动发 status，由 acp-link 的 connect 响应自然推送给前端
    log(`[ACP-Relay] Core relay connected for instance ${instanceId}`);
  }).catch((err) => {
    logError(`[ACP-Relay] Core relay connect failed for instance ${instanceId}: ${err instanceof Error ? err.message : String(err)}`);
    if (ws.readyState === 1) {
      sendToRelayWs(ws, { type: "error", message: "Agent connection error" });
      ws.close(1011, "agent connection error");
    }
  });
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
    instanceId: null,
    relayHandle: null,
    relayUnsub: null,
    outboundBuffer: [],
  });

  log(`[ACP-Relay] EventBus relay established: relayWsId=${relayWsId} → agentId=${agentId}`);
}

/** Called from onMessage — forwards frontend messages.
 *  Accepts either a pre-parsed object (from Elysia WS) or a raw JSON string.
 */
export async function handleRelayMessage(ws: WsConnection, relayWsId: string, data: string | Record<string, unknown>): Promise<void> {
  const entry = relayConnections.get(relayWsId);
  if (!entry) return;

  // Normalize input to parsed object(s)
  let parsed: Record<string, unknown>;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      logError("[ACP-Relay] parse error:", data.substring(0, 120));
      return;
    }
  } else {
    parsed = data;
  }

  log(`[ACP-Relay] handleRelayMessage: relayWsId=${relayWsId} type=${parsed.type} hasRelayHandle=${!!entry.relayHandle} instanceId=${entry.instanceId ?? "(none)"}`);

  // Instance mode: forward messages via core relay handle
  if (entry.relayHandle) {
    if (parsed.type === "connect") {
      // Relay handle already sent connect; acp-link will emit status via onMessage
      log("[ACP-Relay] Skipping frontend connect in instance mode (relay handle auto-connects)");
      return;
    }
    log(`[ACP-Relay] Forwarding outbound to acp-server: type=${parsed.type}`);
    try {
      await entry.relayHandle.send(parsed as any);
    } catch {
      // relay closed — ignore
    }
    return;
  }

  // Instance mode but relay handle not ready yet: buffer the message
  if (entry.instanceId) {
    log(`[ACP-Relay] Buffering outbound message (relay handle not ready): type=${parsed.type}`);
    entry.outboundBuffer.push(parsed);
    return;
  }

  // EventBus mode: forward all ACP messages transparently, only drop keep_alive
  if (parsed.type === "keep_alive") return;

  const sent = sendToAgentWs(entry.agentId, parsed as any);
  if (!sent) {
    sendToRelayWs(ws, { type: "error", message: "Agent connection lost" });
  }
}

/** Called from onClose — cleans up relay connection */
export function handleRelayClose(ws: WsConnection, relayWsId: string, code?: number, reason?: string): void {
  const entry = relayConnections.get(relayWsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(`[ACP-Relay] Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? "none"} reason=${reason || "(none)"} duration=${duration}s`);

  const instanceId = entry.instanceId;

  // Unsubscribe from message forwarding
  if (entry.relayUnsub) {
    entry.relayUnsub();
  }
  if (entry.unsub) {
    entry.unsub();
  }
  if (entry.keepalive) {
    clearInterval(entry.keepalive);
  }

  relayConnections.delete(relayWsId);

  // 如果这是最后一个使用此 instanceId 的 relay 连接，关闭 core relay handle 避免僵尸 WS
  // shutdown 期间跳过：closeAllRelayConnections 已经关闭了 relayHandle，
  // 此处如果再 connectInstanceRelay 会创建新的 WS 连接，导致关闭时出现幽灵 relay
  if (instanceId && !isShuttingDown) {
    const hasOtherRelay = [...relayConnections.values()].some(
      (e) => e.instanceId === instanceId,
    );
    if (!hasOtherRelay) {
      // 通过 facade 关闭 relay：先获取 relay handle 再 close
      // 但 facade 没有暴露 getRelayHandle，所以直接从 entry 取
      // entry 已删除，但 relay handle 仍在 core store 里
      const facade = getCoreRuntime();
      const snapshot = facade.getInstance(instanceId);
      if (snapshot?.relayConnected) {
        // 使用 connectInstanceRelay 获取已有 handle 然后 close
        facade.connectInstanceRelay({ instanceId }).then((handle) => {
          handle.close();
          log(`[ACP-Relay] Closed core relay handle for instance ${instanceId} (last relay disconnected)`);
        }).catch(() => {});
      }
    }
  }
}

/** Close all relay connections (for graceful shutdown) */
export function closeAllRelayConnections(): void {
  if (relayConnections.size === 0) return;

  isShuttingDown = true;
  log(`[ACP-Relay] Closing ${relayConnections.size} relay connection(s)...`);
  for (const [relayWsId, entry] of relayConnections) {
    try {
      // Close core relay handles on shutdown
      if (entry.relayHandle) {
        entry.relayHandle.close();
      }
      if (entry.relayUnsub) {
        entry.relayUnsub();
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

/** Close the relay handle for a specific instance (called when instance is stopped) */
export function closeInstanceRelay(instanceId: string): void {
  for (const [, entry] of relayConnections) {
    if (entry.instanceId === instanceId && entry.relayHandle) {
      try {
        entry.relayHandle.close();
      } catch {}
      entry.relayHandle = null;
      if (entry.relayUnsub) {
        entry.relayUnsub();
        entry.relayUnsub = null;
      }
    }
  }
  log(`[ACP-Relay] Closed relay handles for instance ${instanceId}`);
}

/** Send data to a spawned instance via core relay handle. Returns true if sent. */
export function sendToInstanceRelay(instanceId: string, data: string): boolean {
  for (const [, entry] of relayConnections) {
    if (entry.instanceId === instanceId && entry.relayHandle && entry.relayHandle.state === "open") {
      try {
        const parsed = JSON.parse(data);
        entry.relayHandle.send(parsed);
        return true;
      } catch {
        try {
          entry.relayHandle.send({ type: "raw", payload: data });
          return true;
        } catch {
          return false;
        }
      }
    }
  }
  return false;
}
