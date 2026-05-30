import { log, error as logError } from "../../logger";
import type { EnvironmentRecord } from "../../repositories/environment";
import { environmentRepo } from "../../repositories/environment";
import { getAgentConfigById } from "../../services/config/agent-config";
import type { AcpConnectionEntry, RelayConnectionEntry } from "../../types/store";
import { findMachineConnectionById, sendToWs, setAgentMachineCache } from "../acp-ws-handler";
import type { WsConnection } from "../ws-types";
import { RelayConnectionManager, sendToRelayWs } from "./connection-manager";

const manager = new RelayConnectionManager();

const RELAY_KEEPALIVE_INTERVAL_MS = 20_000;

async function buildAndSendSessionStart(
  ws: WsConnection,
  sessionId: string,
  agentId: string,
  userId: string,
  agentPrompt: string | undefined,
  env: EnvironmentRecord,
): Promise<void> {
  let payload: Record<string, unknown> = { agent_prompt: agentPrompt };

  if (env.agentConfigId) {
    try {
      const { buildLaunchSpec } = await import("../../services/launch-spec-builder");
      const { getAgentFullConfig, getAgentConfigById: getAgentCfg } = await import("../../services/config-pg");
      const agentCfg = await getAgentCfg(env.agentConfigId);
      if (agentCfg) {
        const fullConfig = await getAgentFullConfig(
          { organizationId: env.organizationId ?? "", userId: env.userId ?? "", role: "owner" },
          agentCfg.id,
        );
        const spec = await buildLaunchSpec({
          organizationId: env.organizationId ?? userId,
          userId: env.userId ?? userId,
          environmentId: agentId,
          agentName: agentCfg.name,
          agentConfigId: env.agentConfigId,
          agentPrompt: agentPrompt ?? null,
          modelRef:
            typeof (fullConfig.agentConfig as Record<string, unknown>)?.model === "string"
              ? ((fullConfig.agentConfig as Record<string, unknown>).model as string)
              : null,
          fullConfig,
          environmentSecret: env.secret,
          extraEnv: {
            USER_META_API_KEY: env.secret,
            USER_META_BASE_URL: (await import("../../config")).getBaseUrl(),
          },
        });
        payload = { launch_spec: spec, agent_prompt: agentPrompt };
      }
    } catch (err) {
      logError("[ACP-Relay] Failed to build launch spec for remote machine:", err);
    }
  }

  sendToWs(ws, { type: "session_start", session_id: sessionId, ...payload });
}

// ────────────────────────────────────────────
// Relay open / close / message handlers
// ────────────────────────────────────────────

/** Called from onOpen — routes to local spawn or remote machine based on machineId */
export async function handleRelayOpen(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId?: string,
): Promise<void> {
  log(`[ACP-Relay] Relay connection opened: relayWsId=${relayWsId} agentId=${agentId}`);

  const env = await environmentRepo.getById(agentId);
  if (!env) {
    sendToRelayWs(ws, { type: "error", payload: { message: "Environment not found" } });
    ws.close(4004, "environment not found");
    return;
  }

  // 查 agentConfig 获取 machineId
  let machineId: string | null = null;
  if (env.agentConfigId) {
    const agentCfg = await getAgentConfigById(env.agentConfigId);
    machineId = agentCfg?.machineId ?? null;
  }

  if (machineId) {
    // 远端 machine 路径
    const machineConn = findMachineConnectionById(machineId);
    if (!machineConn) {
      sendToRelayWs(ws, { type: "error", payload: { message: "Machine offline" } });
      ws.close(4004, "machine offline");
      return;
    }
    setAgentMachineCache(agentId, machineId);
    const agentPrompt = await resolveAgentPrompt(env);
    openMachineRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, machineConn, agentPrompt, env);
  } else {
    // 本地路径（默认 machine）
    await openLocalRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, env);
  }
}

async function resolveAgentPrompt(env: EnvironmentRecord): Promise<string | undefined> {
  if (!env.agentConfigId) return;
  const agentCfg = await getAgentConfigById(env.agentConfigId);
  return (agentCfg?.prompt as string) ?? undefined;
}

async function openLocalRelay(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  _sessionId: string,
  _env: EnvironmentRecord,
): Promise<void> {
  const { ensureRunning } = await import("../../services/instance");

  try {
    const result = await ensureRunning(userId, agentId);
    log(`[ACP-Relay] Local instance ${result.status}: instanceId=${result.instance.id} envId=${agentId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendToRelayWs(ws, { type: "error", payload: { message: `Failed to start local instance: ${msg}` } });
    ws.close(1011, "spawn failed");
    return;
  }

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
    instanceId: null,
    relayHandle: null,
    relayUnsub: null,
    outboundBuffer: [],
    sessionStarted: true,
  };
  manager.add(relayWsId, entry);

  // 订阅 EventBus 转发 outbound 消息到前端
  const { getAcpEventBus } = await import("../event-bus");
  const bus = getAcpEventBus(agentId);
  const unsub = bus.subscribe((event) => {
    if (event.direction !== "outbound") return;
    const e = manager.get(relayWsId);
    if (!e || e.ws.readyState !== 1) return;
    sendToRelayWs(e.ws, event.payload as object);
  });
  entry.unsub = unsub;

  log(`[ACP-Relay] Local relay established: relayWsId=${relayWsId} agentId=${agentId}`);
}

function openMachineRelay(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId: string,
  machineConn: AcpConnectionEntry,
  agentPrompt: string | undefined,
  env: EnvironmentRecord,
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
    instanceId: machineConn.machineId, // 复用 instanceId 字段存 machineId
    relayHandle: null,
    relayUnsub: null,
    outboundBuffer: [],
    sessionStarted: false, // 等待 session_started 确认
  };
  manager.add(relayWsId, entry);

  // 设置 machine 连接的 onSessionMessage 回调（保留旧回调链，支持多 relay 共存）
  const prevOnMsg = machineConn.onSessionMessage;
  machineConn.onSessionMessage = (msgSessionId: string, type: string, payload: unknown) => {
    // session_ended / session_error 通知所有 relay（共享 opencode 进程退出影响所有 relay）
    // session_started / session_data 只发给当前 relay（避免重复）
    if (type === "session_ended" || type === "session_error") {
      prevOnMsg?.(msgSessionId, type, payload);
    }
    // 再处理当前 relay
    const e = manager.get(relayWsId);
    if (!e || e.ws.readyState !== 1) return;

    switch (type) {
      case "session_started": {
        e.sessionStarted = true;
        // 开始转发缓冲消息
        for (const buffered of e.outboundBuffer) {
          sendToWs(machineConn.ws, {
            type: "session_data",
            session_id: sessionId,
            payload: buffered,
          });
        }
        e.outboundBuffer.length = 0;
        // 通知前端远端 agent 已就绪（包含 capabilities 以支持 session list）
        const caps = (payload as Record<string, unknown>)?.capabilities ?? {};
        sendToRelayWs(ws, { type: "status", payload: { connected: true, capabilities: caps } });
        break;
      }
      case "session_data":
        // 解包 payload 转发到前端 relay WS
        sendToRelayWs(ws, payload as object);
        break;
      case "session_ended":
      case "session_error":
        // 关闭前端 relay WS
        sendToRelayWs(ws, {
          type: "error",
          payload: { message: ((payload as Record<string, unknown>)?.error as string) || "Session ended" },
        });
        ws.close(1000, type);
        break;
      case "session_queued":
        sendToRelayWs(ws, { type: "status", payload: { connected: false, queued: true } });
        break;
      case "session_resumed":
        e.sessionStarted = true;
        sendToRelayWs(ws, { type: "status", payload: { connected: true, resumed: true } });
        break;
    }
  };

  // 发送 session_start 到 machine WS（携带完整 launch spec）
  buildAndSendSessionStart(machineConn.ws, sessionId, agentId, userId, agentPrompt, env);

  // 超时处理：10s 内未收到 session_started 或 session_queued，则失败
  const spawnTimeout = setTimeout(() => {
    const e = manager.get(relayWsId);
    if (e && !e.sessionStarted) {
      log(`[ACP-Relay] session_start timeout for ${relayWsId}`);
      sendToRelayWs(ws, { type: "error", payload: { message: "Agent spawn timeout" } });
      ws.close(1011, "spawn timeout");
      // 通知 machine 清理可能已 spawn 的 agent 子进程
      sendToWs(machineConn.ws, { type: "session_end", session_id: sessionId });
      manager.remove(relayWsId);
    }
  }, 10000);

  // 成功后清除超时
  const origOnMsg = machineConn.onSessionMessage;
  machineConn.onSessionMessage = (msgSessionId, type, payload) => {
    if (type === "session_started" || type === "session_queued" || type === "session_error") {
      clearTimeout(spawnTimeout);
    }
    origOnMsg?.(msgSessionId, type, payload);
  };

  log(
    `[ACP-Relay] Machine relay established: relayWsId=${relayWsId} → machineId=${machineConn.machineId} sessionId=${sessionId}`,
  );
}

/** Called from onMessage — forwards frontend messages to machine WS */
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

  // ping/pong 处理
  if (parsed.type === "ping") {
    sendToRelayWs(ws, { type: "pong" });
    return;
  }
  if (parsed.type === "keep_alive") return;

  // 本地路径：通过 EventBus 发布 inbound 消息
  if (!entry.instanceId) {
    const { getAcpEventBus } = await import("../event-bus");
    const bus = getAcpEventBus(entry.agentId);
    bus.publish({
      id: `relay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: entry.agentId,
      type: (parsed.type as string) ?? "unknown",
      direction: "inbound",
      payload: parsed,
    });
    return;
  }

  // 远端 machine 路径：通过 machine WS 转发
  const machineConn = findMachineConnectionById(entry.instanceId);
  if (!machineConn) {
    sendToRelayWs(ws, { type: "error", payload: { message: "Machine offline" } });
    return;
  }

  // list_sessions 不缓冲 — 直接转发，机器端 SessionManager 会处理
  // 其他消息在 session_started 前缓冲
  if (!entry.sessionStarted && parsed.type !== "list_sessions") {
    entry.outboundBuffer.push(parsed);
    return;
  }

  // 通过 machine WS 发送 session_data
  sendToWs(machineConn.ws, {
    type: "session_data",
    session_id: relayWsId,
    payload: parsed,
  });
}

/** Called from onClose — cleans up relay connection */
export function handleRelayClose(_ws: WsConnection, relayWsId: string, code?: number, _reason?: string): void {
  const entry = manager.get(relayWsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(
    `[ACP-Relay] Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? "none"} duration=${duration}s`,
  );

  // 发送 session_end 到 machine WS
  const machineId = entry.instanceId;
  if (machineId) {
    const machineConn = findMachineConnectionById(machineId);
    if (machineConn) {
      sendToWs(machineConn.ws, { type: "session_end", session_id: relayWsId });
    }
  }

  manager.remove(relayWsId);
}

// ────────────────────────────────────────────
// Compatibility layer (signatures unchanged)
// ────────────────────────────────────────────

/** 本地 SpawnedInstance 类型定义（instance.ts 删除后的最小化版本） */
export interface SpawnedInstance {
  id: string;
  userId: string;
  port: number;
  pid: number | null;
  status: string;
  command: string;
  error: string | null;
  apiKey: string;
  createdAt: Date;
  environmentId: string;
  instanceNumber: number;
}

/** 兼容层：向 agent 对应的远端 machine 发送消息（同步签名） */
export function sendToAgentWs(agentId: string, msg: object): boolean {
  const { findMachineConnectionById: findById, getAgentMachineCache } = require("../acp-ws-handler");
  const cache = getAgentMachineCache?.() as Map<string, string> | undefined;
  const machineId = cache?.get(agentId);
  if (machineId) {
    const entry = findById(machineId);
    if (entry) {
      sendToWs(entry.ws, {
        type: "session_data",
        session_id: `auto_${agentId}`,
        payload: msg,
      });
      return true;
    }
  }
  return false;
}

/** 兼容层：委托到 instance.ts 的本地 spawn */
export { findRunningInstanceByEnvironment, spawnInstanceFromEnvironment } from "../../services/instance";

/** 关闭指定 machine 的 relay */
export function closeInstanceRelay(instanceId: string): void {
  const entry = findMachineConnectionById(instanceId);
  if (!entry) return;
  sendToWs(entry.ws, { type: "session_end", session_id: `auto_${instanceId}` });
}

/** 向指定 machine 的 relay 发送数据 */
export function sendToInstanceRelay(instanceId: string, data: string): boolean {
  const entry = findMachineConnectionById(instanceId);
  if (!entry) return false;
  try {
    const parsed = JSON.parse(data);
    sendToWs(entry.ws, {
      type: "session_data",
      session_id: `auto_${instanceId}`,
      payload: parsed,
    });
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────
// Shutdown
// ────────────────────────────────────────────

/** Close all relay connections (for graceful shutdown) */
export function closeAllRelayConnections(): void {
  if (manager.size === 0) return;

  manager.isShuttingDown = true;
  log(`[ACP-Relay] Closing ${manager.size} relay connection(s)...`);
  for (const [, entry] of manager.entries()) {
    try {
      clearInterval(entry.keepalive!);
      entry.unsub?.();
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

/** machine 断连后标记所有关联 relay entry 为 pendingReconnect */
export function handleMachineDisconnected(machineId: string): void {
  for (const [relayWsId, entry] of manager.entries()) {
    if (entry.instanceId === machineId) {
      entry.pendingReconnect = true;
      entry.machineWsId = undefined;
      log(`[ACP-Relay] Machine ${machineId} disconnected, relay ${relayWsId} pending reconnect`);
    }
  }
}
