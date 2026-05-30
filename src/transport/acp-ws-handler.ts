import { config } from "../config";
import { log, error as logError } from "../logger";
import { touchEnvironmentPoll } from "../services/environment";
import { disconnectMachine, registerMachine } from "../services/registry";
import type { AcpConnectionEntry } from "../types/store";
import type { WsConnection } from "./ws-types";

const connections = new Map<string, AcpConnectionEntry>();

const SERVER_KEEPALIVE_INTERVAL_MS = config.wsKeepaliveInterval * 1000;
const _CLIENT_ACTIVITY_TIMEOUT_MS = SERVER_KEEPALIVE_INTERVAL_MS * 3;

export function sendToWs(ws: WsConnection, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(`${JSON.stringify(msg)}\n`);
  } catch (err) {
    logError("[ACP-WS] send error:", err);
  }
}

/** Called from onOpen — initializes connection tracking */
export function handleAcpWsOpen(
  ws: WsConnection,
  wsId: string,
  userId: string,
  _boundEnvId?: string | null,
  isMachine?: boolean,
): void {
  if (isMachine) {
    // machine 连接不订阅 ACP event bus、不调用 handleAcpConnect
    // 心跳由 registry-heartbeat 服务管理，不在 onOpen 阶段启动
    log(`[ACP-WS] Machine connection opened: wsId=${wsId}`);
    connections.set(wsId, {
      agentId: null,
      boundEnvId: null,
      userId,
      unsub: null,
      keepalive: null,
      ws,
      openTime: Date.now(),
      lastClientActivity: Date.now(),
      capabilities: null,
      isMachine: true,
      machineId: null,
      wsId,
    });
    return;
  }

  // 非 machine 连接不再支持 — ACP agent 直连模型已废弃
  log(`[ACP-WS] Non-machine connection rejected: wsId=${wsId}`);
  ws.close(4003, "ACP agent connections no longer supported; use machine registration");
}

/** Handle machine register message — WS registration for machine */
async function handleMachineRegister(wsId: string, msg: Record<string, unknown>): Promise<void> {
  const entry = connections.get(wsId);
  if (!entry) return;

  if (entry.machineId) {
    // 已注册，返回已有 machineId
    sendToWs(entry.ws, { type: "registered", machine_id: entry.machineId });
    return;
  }

  const agentName = (msg.agent_name as string) || "unknown";
  const machineInfo = msg.machine_info as Record<string, unknown> | undefined;
  const labels = Array.isArray(msg.labels) ? (msg.labels as string[]) : [];
  const heartbeatIntervalMs = typeof msg.heartbeat_interval_ms === "number" ? msg.heartbeat_interval_ms : 30000;
  const tenantId = (msg.tenant_id as string) || null;
  const userId = (msg.user_id as string) || null;

  process.stderr.write(`[ACP-WS] handleMachineRegister called, agent=${agentName}\n`);
  try {
    const result = await registerMachine({
      agentName,
      machineInfo: machineInfo ?? null,
      labels,
      heartbeatIntervalMs,
      tenantId,
      userId,
    });

    entry.machineId = result.id;
    log(`[ACP-WS] Machine registered: id=${result.id} agent=${agentName}`);

    sendToWs(entry.ws, {
      type: "registered",
      machine_id: result.id,
    });
  } catch (err) {
    console.error("[ACP-WS] Machine register error:", err);
    logError("[ACP-WS] Machine register error:", err);
    sendToWs(entry.ws, { type: "error", message: "Machine registration failed" });
  }
}

/** Handle machine disconnection — updates status and writes event */
async function handleMachineDisconnect(entry: AcpConnectionEntry, reason?: string): Promise<void> {
  if (!entry.machineId) return;

  try {
    await disconnectMachine(entry.machineId, reason ?? "connection closed");
    log(`[ACP-WS] Machine disconnected: id=${entry.machineId} reason=${reason ?? "(none)"}`);
  } catch (err) {
    logError("[ACP-WS] Machine disconnect error:", err);
  }
}

/** Handle register message — all connections are machine connections */
async function handleRegister(wsId: string, msg: Record<string, unknown>): Promise<void> {
  const entry = connections.get(wsId);
  if (!entry) return;

  // 所有连接均为 machine 连接，走 machine 注册流程
  await handleMachineRegister(wsId, msg);
}

/** Called from onMessage — processes NDJSON lines or pre-parsed objects */
export async function handleAcpWsMessage(
  _ws: WsConnection,
  wsId: string,
  data: string | Record<string, unknown>,
): Promise<void> {
  const entry = connections.get(wsId);
  if (!entry) return;

  entry.lastClientActivity = Date.now();

  // Normalize to array of parsed messages
  const messages: Record<string, unknown>[] = [];
  if (typeof data === "string") {
    for (const line of data.split("\n").filter((l) => l.trim())) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        logError("[ACP-WS] parse error:", line);
      }
    }
  } else {
    messages.push(data);
  }

  for (const msg of messages) {
    if (msg.type === "keep_alive") {
      if (entry.agentId) {
        touchEnvironmentPoll(entry.agentId).catch(() => {});
      }
      continue;
    }

    if (msg.type === "heartbeat") {
      if (entry.isMachine && entry.machineId) {
        const { handleHeartbeat } = await import("../services/registry-heartbeat");
        handleHeartbeat(entry.machineId).catch((err) => {
          logError("[ACP-WS] Heartbeat handling error:", err);
        });
      }
      continue;
    }

    // machine 连接：session 生命周期消息转发到 relay 层
    const SESSION_MSG_TYPES = [
      "session_started",
      "session_data",
      "session_ended",
      "session_error",
      "session_queued",
      "session_resumed",
    ];
    if (entry.isMachine && SESSION_MSG_TYPES.includes(msg.type as string)) {
      const sessionId = msg.session_id as string | undefined;
      if (sessionId && entry.onSessionMessage) {
        entry.onSessionMessage(sessionId, msg.type as string, (msg as Record<string, unknown>).payload);
      }
      continue;
    }

    if (msg.type === "register") {
      handleRegister(wsId, msg).catch((err) => {
        logError("[ACP-WS] Error in register handler:", err);
      });
    }

    // 未识别的消息类型静默忽略（不再走 EventBus 发布）
  }
}

/** Called from onClose — marks agent offline and cleans up */
export function handleAcpWsClose(_ws: WsConnection, wsId: string, code?: number, reason?: string): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(
    `[ACP-WS] Connection closed: wsId=${wsId} agentId=${entry.agentId} code=${code ?? "none"} reason=${reason || "(none)"} duration=${duration}s`,
  );

  if (entry.unsub) entry.unsub();
  if (entry.keepalive) clearInterval(entry.keepalive);

  // machine 连接断连处理
  if (entry.isMachine) {
    const reasonStr = reason ?? undefined;
    handleMachineDisconnect(entry, reasonStr).catch(() => {});
  }

  connections.delete(wsId);
}

/** agentId (environment.id) → machineId 缓存，供同步 sendToAgentWs 使用 */
const agentMachineCache = new Map<string, string>();

/** 通过 machineId 查找在线的 machine WebSocket 连接 */
export function findMachineConnectionById(machineId: string): AcpConnectionEntry | null {
  for (const entry of connections.values()) {
    if (entry.isMachine && entry.machineId === machineId && entry.ws.readyState === 1) {
      return entry;
    }
  }
  return null;
}

/** 通过 agentId 查找在线的 machine WebSocket 连接（异步，含 DB 查询）。结果会缓存到 agentMachineCache。 */
export async function findMachineConnectionByAgentId(agentId: string): Promise<AcpConnectionEntry | null> {
  // 1. 先查缓存
  const cachedMachineId = agentMachineCache.get(agentId);
  if (cachedMachineId) {
    return findMachineConnectionById(cachedMachineId);
  }
  // 2. 查 environment → agentConfig → machineId
  const { environmentRepo } = await import("../repositories/environment");
  const env = await environmentRepo.getById(agentId);
  if (!env?.agentConfigId) return null;
  const { getAgentConfigById } = await import("../services/config/agent-config");
  const agentCfg = await getAgentConfigById(env.agentConfigId);
  if (!agentCfg?.machineId) return null;
  // 3. 缓存并查找连接
  agentMachineCache.set(agentId, agentCfg.machineId);
  return findMachineConnectionById(agentCfg.machineId);
}

/** 导出 agentMachineCache 供 relay-handler 预热和查询 */
export function getAgentMachineCache(): Map<string, string> {
  return agentMachineCache;
}

/** 设置 agentMachineCache 条目（供 relay-handler 预热） */
export function setAgentMachineCache(agentId: string, machineId: string): void {
  agentMachineCache.set(agentId, machineId);
}

/** 向 agent 对应的远端 machine 发送消息（兼容层，保留同步签名）。
 * 优先使用 agentMachineCache；cache miss 时遍历连接做 best-effort 发送。
 * 返回 true 表示消息已发送到至少一个 machine WS。 */
export function sendToAgentWs(agentId: string, msg: object): boolean {
  // 1. 优先走缓存
  const cachedMachineId = agentMachineCache.get(agentId);
  if (cachedMachineId) {
    const entry = findMachineConnectionById(cachedMachineId);
    if (entry) {
      sendToWs(entry.ws, {
        type: "session_data",
        session_id: `auto_${agentId}`,
        payload: msg,
      });
      return true;
    }
    // machineId 缓存命中但连接已断，清除过期缓存
    agentMachineCache.delete(agentId);
  }
  // 2. cache miss — 无法确定 agent 对应哪台 machine，返回 false
  return false;
}

/** Gracefully close all ACP WebSocket connections */
export function closeAllAcpConnections(): void {
  if (connections.size === 0) return;

  log(`[ACP-WS] Gracefully closing ${connections.size} ACP connection(s)...`);
  for (const [_wsId, entry] of connections) {
    try {
      if (entry.unsub) entry.unsub();
      if (entry.keepalive) clearInterval(entry.keepalive);
      if (entry.ws.readyState === 1) {
        entry.ws.close(1001, "server_shutdown");
      }
      if (entry.isMachine && entry.machineId) {
        disconnectMachine(entry.machineId, "server_shutdown").catch(() => {});
      }
    } catch {
      // ignore errors during shutdown
    }
  }
  connections.clear();
  log("[ACP-WS] All connections closed");
}
