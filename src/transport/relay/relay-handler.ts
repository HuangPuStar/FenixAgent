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

// ────────────────────────────────────────────
// Relay open / close / message handlers
// ────────────────────────────────────────────

/** Called from onOpen — finds Environment → AgentConfig → machineId → machine WS */
export async function handleRelayOpen(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId?: string,
): Promise<void> {
  log(`[ACP-Relay] Relay connection opened: relayWsId=${relayWsId} agentId=${agentId}`);

  // 查 Environment → AgentConfig → machineId → machine WS 连接
  const env = await environmentRepo.getById(agentId);
  if (!env?.agentConfigId) {
    sendToRelayWs(ws, { type: "error", message: "Agent not found or not bound to a machine" });
    ws.close(4004, "agent not bound to machine");
    return;
  }
  const agentCfg = await getAgentConfigById(env.agentConfigId);
  if (!agentCfg?.machineId) {
    sendToRelayWs(ws, { type: "error", message: "Agent not bound to a machine" });
    ws.close(4004, "agent not bound to machine");
    return;
  }
  const machineConn = findMachineConnectionById(agentCfg.machineId);
  if (!machineConn) {
    sendToRelayWs(ws, { type: "error", message: "Agent not found or offline" });
    ws.close(4004, "agent not found");
    return;
  }

  // 预热 agentMachineCache（供后续 sendToAgentWs 同步调用）
  setAgentMachineCache(agentId, agentCfg.machineId);

  // 提取 agent prompt，传给 SessionManager（Phase 2 删除了 Instance 链路，需要在这里恢复）
  const agentPrompt = (agentCfg.prompt as string) ?? undefined;

  openMachineRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, machineConn, agentPrompt);
}

function openMachineRelay(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId: string,
  machineConn: AcpConnectionEntry,
  agentPrompt?: string,
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
        sendToRelayWs(ws, { type: "error", message: (payload as Record<string, unknown>)?.error || "Session ended" });
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

  // 发送 session_start 到 machine WS（携带 agentPrompt 以恢复 Phase 2 删除的 Instance 链路）
  sendToWs(machineConn.ws, { type: "session_start", session_id: sessionId, agent_prompt: agentPrompt });

  // 超时处理：10s 内未收到 session_started 或 session_queued，则失败
  const spawnTimeout = setTimeout(() => {
    const e = manager.get(relayWsId);
    if (e && !e.sessionStarted) {
      log(`[ACP-Relay] session_start timeout for ${relayWsId}`);
      sendToRelayWs(ws, { type: "error", message: "Agent spawn timeout" });
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

  // 获取 machine 连接
  const machineConn = findMachineConnectionById(entry.instanceId ?? "");
  if (!machineConn) {
    sendToRelayWs(ws, { type: "error", message: "Machine offline" });
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

/** 兼容层：通过 environmentId 查找对应 machine 在线状态，返回虚拟 SpawnedInstance */
export async function findRunningInstanceByEnvironment(
  environmentId: string,
  _userId?: string,
): Promise<SpawnedInstance | undefined> {
  const { findMachineConnectionByAgentId } = await import("../acp-ws-handler");
  const entry = await findMachineConnectionByAgentId(environmentId);
  if (!entry) return;
  return {
    id: entry.machineId!,
    userId: entry.userId,
    port: 0,
    pid: null,
    status: entry.ws.readyState === 1 ? "running" : "stopped",
    command: "",
    error: null,
    apiKey: "",
    createdAt: new Date(entry.openTime),
    environmentId,
    instanceNumber: 1,
  };
}

/** 兼容层：通过 machine WS 请求远端 spawn agent 子进程 */
export async function spawnInstanceFromEnvironment(
  userId: string,
  environmentId: string,
  _prefetchedEnv?: EnvironmentRecord,
  _extraEnv?: Record<string, string>,
): Promise<SpawnedInstance> {
  const { findMachineConnectionByAgentId } = await import("../acp-ws-handler");
  const entry = await findMachineConnectionByAgentId(environmentId);
  if (!entry) {
    const { NotFoundError } = await import("../../errors");
    throw new NotFoundError("No online machine for this environment");
  }

  const sessionId = `auto_${environmentId}_${Date.now()}`;
  sendToWs(entry.ws, { type: "session_start", session_id: sessionId });

  // 等待 session_started（超时 30s）
  const started = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 30000);
    const origCb = entry.onSessionMessage;
    entry.onSessionMessage = (msgSessionId, type) => {
      if (msgSessionId === sessionId && type === "session_started") {
        clearTimeout(timeout);
        resolve(true);
      }
      origCb?.(msgSessionId, type, undefined);
    };
  });

  if (!started) {
    const { AppError } = await import("../../errors");
    throw new AppError("Remote agent spawn timeout", "SPAWN_TIMEOUT", 504);
  }

  return {
    id: entry.machineId!,
    userId,
    port: 0,
    pid: null,
    status: "running",
    command: "",
    error: null,
    apiKey: "",
    createdAt: new Date(),
    environmentId,
    instanceNumber: 1,
  };
}

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
