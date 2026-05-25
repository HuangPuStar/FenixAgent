import type { EngineRelayMessage } from "@mothership/plugin-sdk";
import { log, error as logError } from "../../logger";
import { getCoreRuntime } from "../../services/core-bootstrap";
import { findInstanceBySessionId, findRunningInstanceByEnvironment } from "../../services/instance";
import { findAcpConnectionByAgentId, sendToAgentWs } from "../acp-ws-handler";
import type { WsConnection } from "../ws-types";
import type { RelayConnectionEntry } from "./connection-manager";
import { RelayConnectionManager, sendToRelayWs } from "./connection-manager";
import { flushOutboundBuffer, publishToEventBus } from "./message-router";

const manager = new RelayConnectionManager();

const RELAY_KEEPALIVE_INTERVAL_MS = 20_000;

/** Called from onOpen — finds target agent and bridges connection */
export function handleRelayOpen(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId?: string,
): void {
  log(
    `[ACP-Relay] Relay connection opened: relayWsId=${relayWsId} agentId=${agentId} userId=${userId} sessionId=${sessionId ?? "(none)"}`,
  );

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
function openInstanceRelay(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  instanceId: string,
): void {
  const relayKeepalive = setInterval(() => {
    const entry = manager.get(relayWsId);
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
  manager.add(relayWsId, entry);

  const facade = getCoreRuntime();
  facade
    .connectInstanceRelay({
      instanceId,
      sessionId: relayWsId,
    })
    .then((handle) => {
      if (ws.readyState !== 1) {
        handle.close();
        return;
      }

      entry.relayHandle = handle;

      // Flush buffered outbound messages
      flushOutboundBuffer(entry.outboundBuffer, { send: (msg: unknown) => handle.send(msg as EngineRelayMessage) });

      // Subscribe to inbound messages from engine
      if ("onMessage" in handle && typeof (handle as { onMessage?: unknown }).onMessage === "function") {
        const opencodeHandle = handle as {
          onMessage: (listener: (msg: Record<string, unknown>) => void) => () => void;
        };
        entry.relayUnsub = opencodeHandle.onMessage((message) => {
          log(
            `[ACP-Relay] Forwarding to frontend: type=${(message as Record<string, unknown>).type} readyState=${ws.readyState}`,
          );
          publishToEventBus(agentId, message);
          if (ws.readyState === 1) {
            sendToRelayWs(ws, message);
          } else {
            log(
              `[ACP-Relay] Frontend WS not open (state=${ws.readyState}), dropping message type=${(message as Record<string, unknown>).type}`,
            );
          }
        });
        log(`[ACP-Relay] onMessage listener registered for instance ${instanceId}`);
      } else {
        logError(
          `[ACP-Relay] Relay handle missing onMessage for instance ${instanceId}, handle keys: ${Object.keys(handle).join(",")}`,
        );
      }

      log(`[ACP-Relay] Core relay connected for instance ${instanceId}`);
    })
    .catch((err) => {
      logError(
        `[ACP-Relay] Core relay connect failed for instance ${instanceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (ws.readyState === 1) {
        sendToRelayWs(ws, { type: "error", message: "Agent connection error" });
        ws.close(1011, "agent connection error");
      }
    });
}

/** EventBus mode: for direct acp-link WS connections */
function openEventBusRelay(ws: WsConnection, relayWsId: string, agentId: string, userId: string): void {
  const keepalive = setInterval(() => {
    const entry = manager.get(relayWsId);
    if (!entry || entry.ws.readyState !== 1) {
      clearInterval(keepalive);
      return;
    }
    sendToRelayWs(entry.ws, { type: "keep_alive" });
  }, RELAY_KEEPALIVE_INTERVAL_MS);

  const { getAcpEventBus } = require("../event-bus");
  const bus = getAcpEventBus(agentId);
  const unsub = bus.subscribe((event: Record<string, unknown>) => {
    if (ws.readyState !== 1) return;
    if (event.direction !== "inbound") return;
    if (event.type === "agent_disconnect") {
      sendToRelayWs(ws, { type: "status", payload: { connected: false } });
      return;
    }
    sendToRelayWs(ws, event.payload as object);
  });

  manager.add(relayWsId, {
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

/** Called from onMessage — forwards frontend messages. */
export async function handleRelayMessage(
  ws: WsConnection,
  relayWsId: string,
  data: string | Record<string, unknown>,
): Promise<void> {
  const entry = manager.get(relayWsId);
  if (!entry) return;

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

  log(
    `[ACP-Relay] handleRelayMessage: relayWsId=${relayWsId} type=${parsed.type} hasRelayHandle=${!!entry.relayHandle} instanceId=${entry.instanceId ?? "(none)"}`,
  );

  // Instance mode: forward messages via core relay handle
  if (entry.relayHandle) {
    if (parsed.type === "connect") {
      log("[ACP-Relay] Skipping frontend connect in instance mode (relay handle auto-connects)");
      return;
    }
    if (parsed.type === "ping") {
      sendToRelayWs(ws, { type: "pong" });
      return;
    }
    log(`[ACP-Relay] Forwarding outbound to acp-server: type=${parsed.type}`);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: relay handle send accepts dynamic message types
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

  // biome-ignore lint/suspicious/noExplicitAny: sendToAgentWs accepts dynamic message types
  const sent = sendToAgentWs(entry.agentId, parsed as any);
  if (!sent) {
    sendToRelayWs(ws, { type: "error", message: "Agent connection lost" });
  }
}

/** Called from onClose — cleans up relay connection */
export function handleRelayClose(_ws: WsConnection, relayWsId: string, code?: number, reason?: string): void {
  const entry = manager.get(relayWsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(
    `[ACP-Relay] Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? "none"} reason=${reason || "(none)"} duration=${duration}s`,
  );

  const instanceId = entry.instanceId;
  manager.remove(relayWsId);

  // 如果这是最后一个使用此 instanceId 的 relay 连接，关闭 core relay handle
  if (instanceId && !manager.isShuttingDown) {
    if (!manager.hasOtherRelayForInstance(instanceId)) {
      if (entry.relayHandle) {
        try {
          entry.relayHandle.close();
          log(`[ACP-Relay] Closed core relay handle for instance ${instanceId} (last relay disconnected)`);
        } catch {}
      } else if (instanceId) {
        const facade = getCoreRuntime();
        const snapshot = facade.getInstance(instanceId);
        if (snapshot?.relayConnected) {
          facade
            .connectInstanceRelay({ instanceId })
            .then((handle) => {
              handle.close();
              log(`[ACP-Relay] Closed core relay handle for instance ${instanceId} (last relay disconnected)`);
            })
            .catch(() => {});
        }
      }
    }
  }
}

/** Close all relay connections (for graceful shutdown) */
export function closeAllRelayConnections(): void {
  if (manager.size === 0) return;

  manager.isShuttingDown = true;
  log(`[ACP-Relay] Closing ${manager.size} relay connection(s)...`);
  for (const [, entry] of manager.entries()) {
    try {
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
  manager.clear();
  log("[ACP-Relay] All connections closed");
}

/** Close the relay handle for a specific instance (called when instance is stopped) */
export function closeInstanceRelay(instanceId: string): void {
  for (const [, entry] of manager.entries()) {
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
  for (const [, entry] of manager.entries()) {
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
