import { createLogger, error as logError } from "@fenix/logger";
import { config } from "../config";
import { touchInstanceActivity } from "../services/acp-idle-monitor";
import { getCoreRuntime, registerRemoteNode, unregisterRemoteNode } from "../services/core-bootstrap";
import { touchEnvironmentPoll } from "../services/environment";
import { disconnectMachine, registerMachine } from "../services/registry";
import { handleHeartbeat, startHeartbeat, stopHeartbeat } from "../services/registry-heartbeat";
import type { AcpConnectionEntry } from "../types/store";
import type { WsConnection } from "./ws-types";

const logger = createLogger("transport-acp-ws-handler");

const connections = new Map<string, AcpConnectionEntry>();

const SERVER_KEEPALIVE_INTERVAL_MS = config.wsKeepaliveInterval * 1000;
const _CLIENT_ACTIVITY_TIMEOUT_MS = SERVER_KEEPALIVE_INTERVAL_MS * 3;

export function sendToWs(ws: WsConnection, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(`${JSON.stringify(msg)}\n`);
  } catch (err) {
    logError("send error:", err);
  }
}

/** Called from onOpen — initializes connection tracking */
export function handleAcpWsOpen(
  ws: WsConnection,
  wsId: string,
  userId: string,
  boundEnvId?: string | null,
  isMachine?: boolean,
): void {
  if (isMachine) {
    // machine 连接不订阅 ACP event bus、不调用 handleAcpConnect
    // 心跳由 registry-heartbeat 服务管理，不在 onOpen 阶段启动
    logger.debug(`Machine connection opened: wsId=${wsId}`);
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
      sessionMessageListeners: new Map(),
    });
    return;
  }

  // 本地 acp-link 回连（旧架构路径）
  if (boundEnvId) {
    logger.debug(`Local acp-link connection opened: wsId=${wsId} boundEnvId=${boundEnvId}`);
    import("../services/environment-acp").then(({ handleAcpConnect }) => {
      handleAcpConnect(boundEnvId).catch(() => {});
    });

    const keepalive = setInterval(() => {
      const entry = connections.get(wsId);
      if (entry?.ws.readyState !== 1) {
        clearInterval(keepalive);
        return;
      }
      const silenceMs = Date.now() - entry.lastClientActivity;
      if (silenceMs > _CLIENT_ACTIVITY_TIMEOUT_MS) {
        logger.debug(`Client inactive for ${Math.round(silenceMs / 1000)}s, closing dead connection`);
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
      agentId: boundEnvId,
      boundEnvId,
      userId,
      unsub: null,
      keepalive,
      ws,
      openTime: Date.now(),
      lastClientActivity: Date.now(),
      capabilities: null,
      isMachine: false,
      machineId: null,
      wsId,
    });

    // 订阅 EventBus 转发 outbound 消息
    import("./event-bus").then(({ getAcpEventBus }) => {
      const bus = getAcpEventBus(boundEnvId);
      const unsub = bus.subscribe((event) => {
        const entry = connections.get(wsId);
        if (entry?.ws.readyState !== 1) return;
        if (event.direction !== "outbound") return;
        sendToWs(entry.ws, event.payload as object);
      });
      const entry = connections.get(wsId);
      if (entry) entry.unsub = unsub;
    });
    return;
  }

  // 既非 machine 也非 boundEnvId — 拒绝
  logger.debug(`Unidentified connection rejected: wsId=${wsId}`);
  ws.close(4003, "Unidentified connection; provide either boundEnvId or registry secret");
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
  const name = (msg.name as string) || null;
  const machineInfo = msg.machine_info as Record<string, unknown> | undefined;
  const labels = Array.isArray(msg.labels) ? (msg.labels as string[]) : [];
  const heartbeatIntervalMs = typeof msg.heartbeat_interval_ms === "number" ? msg.heartbeat_interval_ms : 30000;
  const tenantId = (msg.tenant_id as string) || null;
  const userId = (msg.user_id as string) || null;
  const supportedEngineTypes = Array.isArray(msg.supported_engine_types)
    ? (msg.supported_engine_types as { type: string; cliPath?: string }[])
    : [{ type: "opencode" }];
  // 客户端持久化的 node_id，用于精确去重（避免 IP/MAC 变化导致重复注册）
  const nodeId = (msg.node_id as string) || null;
  // 客户端指定的 machine id，用于固定机器标识
  const specifiedMachineId = (msg.machine_id as string) || null;

  try {
    const result = await registerMachine({
      name,
      agentName,
      machineInfo: machineInfo ?? null,
      labels,
      heartbeatIntervalMs,
      tenantId,
      userId,
      nodeId,
      machineId: specifiedMachineId,
    });

    entry.machineId = result.id;
    logger.debug(`Machine registered: id=${result.id} agent=${agentName} isNew=${result.isNew}`);

    // 注册远程 node 到 core runtime（传入 entry 以便 transport 接收路由消息）
    const engineTypes = supportedEngineTypes.map((e) => e.type);
    registerRemoteNode(result.id, entry.ws, entry, engineTypes);

    // 重连场景：关闭旧 relay 连接，让前端自动重连并使用新 transport
    if (!result.isNew) {
      import("./relay/relay-handler").then(({ handleMachineReconnect }) => {
        handleMachineReconnect(result.id);
      });
    }

    sendToWs(entry.ws, {
      type: "registered",
      machine_id: result.id,
      is_new: result.isNew,
    });

    // 启动心跳超时检测：远程服务直接关闭时 TCP 不会发 FIN，
    // 依赖心跳超时触发完整断连清理（包括关闭前端 relay WS）
    logger.info(
      `[MACHINE-REGISTER] Starting heartbeat for machineId=${result.id} interval=${heartbeatIntervalMs}ms timeout=${heartbeatIntervalMs * 3}ms`,
    );
    startHeartbeat(result.id, heartbeatIntervalMs, () => {
      logger.info(`[MACHINE-HEARTBEAT] Timeout triggered for machineId=${result.id}`);
      triggerMachineDisconnect(wsId, result.id, "heartbeat timeout");
    });
  } catch (err) {
    logError("Machine register error:", err);
    sendToWs(entry.ws, { type: "error", message: "Machine registration failed" });
  }
}

/** Handle machine disconnection — updates status and writes event */
async function handleMachineDisconnect(entry: AcpConnectionEntry, reason?: string): Promise<void> {
  if (!entry.machineId) return;

  try {
    await disconnectMachine(entry.machineId, reason ?? "connection closed");
    logger.debug(`Machine disconnected: id=${entry.machineId} reason=${reason ?? "(none)"}`);
  } catch (err) {
    logError("Machine disconnect error:", err);
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
        logError("parse error:", line);
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
        handleHeartbeat(entry.machineId).catch((err) => {
          logError("Heartbeat handling error:", err);
        });
      }
      continue;
    }

    // machine 连接：新协议消息（prepare_result/start_result/stop_result/relay）路由到 remote transport
    if (entry.isMachine && entry.remoteTransport) {
      const REMOTE_PROTOCOL_TYPES = ["prepare_result", "start_result", "stop_result", "relay"];
      if (REMOTE_PROTOCOL_TYPES.includes(msg.type as string)) {
        const instanceId = (msg as Record<string, unknown>).instance_id;
        if (typeof instanceId === "string") {
          touchInstanceActivity(instanceId, msg);
        }
        logger.debug("ACP ← remote", {
          type: msg.type,
          machineId: entry.machineId,
          instanceId: (msg as Record<string, unknown>).instance_id,
          payload: JSON.stringify(msg).slice(0, 300),
        });
        entry.remoteTransport.injectMessage(msg as unknown as import("@fenix/remote-runtime").TransportMessage);
        continue;
      }
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
      const instanceId = (msg as Record<string, unknown>).instance_id;
      if (typeof instanceId === "string") {
        touchInstanceActivity(instanceId, msg);
      }
      logger.debug("ACP ← session", {
        type: msg.type,
        machineId: entry.machineId,
        sessionId,
        payload: JSON.stringify(msg).slice(0, 300),
      });
      if (sessionId) {
        const listener = entry.sessionMessageListeners?.get(sessionId);
        if (listener) {
          listener(sessionId, msg.type as string, (msg as Record<string, unknown>).payload);
        }
        // 兼容旧 onSessionMessage 回调
        if (entry.onSessionMessage) {
          entry.onSessionMessage(sessionId, msg.type as string, (msg as Record<string, unknown>).payload);
        }
      }
      continue;
    }

    if (msg.type === "register") {
      handleRegister(wsId, msg).catch((err) => {
        logError("Error in register handler:", err);
      });
      continue;
    }

    // 本地 acp-link 连接的消息处理
    if (!entry.isMachine && entry.agentId) {
      if (msg.type === "identify") {
        const agentId = msg.agent_id as string;
        if (agentId) {
          entry.agentId = agentId;
          entry.boundEnvId = agentId;
          sendToWs(entry.ws, { type: "identified", agent_id: agentId });
          logger.debug(`Agent identified: wsId=${wsId} agentId=${agentId}`);
        }
      }
    }

    // 未识别的消息类型静默忽略（不再走 EventBus 发布）
  }
}

/**
 * 机器断连的完整清理流程。
 * 同时被 handleAcpWsClose（WS 正常关闭）、triggerMachineDisconnect（心跳超时/sweep 检测）复用。
 */
function performMachineCleanup(entry: AcpConnectionEntry, reason?: string): void {
  const machineId = entry.machineId;
  if (!machineId) return;

  // 检查是否已有更新的 WS 连接接管了此 machineId（快速重连场景）
  const activeConn = findMachineConnectionById(machineId);
  if (activeConn) {
    logger.info(
      `[MACHINE-CLEANUP] Machine ${machineId} has newer active connection (wsId=${activeConn.wsId}) — closing stale relay connections`,
    );
    // 即使有新连接接管，仍需关闭旧 relay 连接，让前端重连使用新 transport
    // 跳过 DB/core 清理（新连接已接管），但必须触发 relay 层刷新
    import("./relay/relay-handler").then(({ handleMachineReconnect }) => {
      handleMachineReconnect(machineId);
    });
    return;
  }

  logger.info(`[MACHINE-CLEANUP] Starting full cleanup for machineId=${machineId} reason=${reason ?? "unknown"}`);

  // 无其他活跃连接，执行完整断连清理
  handleMachineDisconnect(entry, reason).catch(() => {});
  unregisterRemoteNode(machineId);
  stopHeartbeat(machineId);
  // 清理 RCS registry 中对应 machineId 的孤儿 supplement
  import("../services/instance-registry").then(({ globalInstanceRegistry }) => {
    const facade = getCoreRuntime();
    globalInstanceRegistry.reconcile(() => facade.listInstances());
  });
  import("./relay/relay-handler").then(({ handleMachineDisconnected }) => {
    logger.info(`[MACHINE-CLEANUP] Calling handleMachineDisconnected for machineId=${machineId}`);
    handleMachineDisconnected(machineId);
  });
}

/**
 * 心跳超时或 sweep 检测到断连时，主动触发完整清理。
 * 需要关闭残留的 WS 并执行 performMachineCleanup。
 */
function triggerMachineDisconnect(wsId: string, machineId: string, reason: string): void {
  const entry = connections.get(wsId);
  if (!entry) {
    // entry 已被删除（例如 WS 已正常关闭），直接按 machineId 做清理
    triggerMachineCleanupByMachineId(machineId, reason);
    return;
  }

  logger.debug(`Triggering machine disconnect: wsId=${wsId} machineId=${machineId} reason=${reason}`);

  // 关闭残留 WS 连接
  if (entry.ws.readyState === 1) {
    try {
      entry.ws.close(1011, reason);
    } catch {
      /* ignore */
    }
  }
  connections.delete(wsId);
  performMachineCleanup(entry, reason);
}

/** 仅凭 machineId 做清理（entry 已不存在时由 sweep 使用）。导出供 registry-heartbeat sweep 调用。 */
export function triggerMachineCleanupByMachineId(machineId: string, reason: string): void {
  // 先检查是否有活跃连接（可能已重连）
  const activeConn = findMachineConnectionById(machineId);
  if (activeConn) return;

  // 更新 DB 状态
  disconnectMachine(machineId, reason).catch((err) => {
    logError("Machine disconnect error:", err);
  });

  unregisterRemoteNode(machineId);
  stopHeartbeat(machineId);
  import("./relay/relay-handler").then(({ handleMachineDisconnected }) => {
    handleMachineDisconnected(machineId);
  });
}

/** Called from onClose — marks agent offline and cleans up */
export function handleAcpWsClose(_ws: WsConnection, wsId: string, code?: number, reason?: string): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  logger.info(
    `[ACP-WS-CLOSE] wsId=${wsId} isMachine=${entry.isMachine} machineId=${entry.machineId ?? "none"} code=${code ?? "none"} reason=${reason || "(none)"} duration=${duration}s`,
  );

  if (entry.unsub) entry.unsub();
  if (entry.keepalive) clearInterval(entry.keepalive);

  // 先删除连接记录，避免后续清理逻辑查到已失效的旧 entry
  connections.delete(wsId);

  // machine 连接断连处理
  if (entry.isMachine && entry.machineId) {
    logger.info(`[ACP-WS-CLOSE] calling performMachineCleanup for machineId=${entry.machineId}`);
    performMachineCleanup(entry, reason ?? undefined);
  }
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
      logger.debug("ACP → remote", {
        agentId,
        machineId: cachedMachineId,
        payloadType: (msg as Record<string, unknown>).type,
        msg,
      });
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

  logger.debug(`Gracefully closing ${connections.size} ACP connection(s)...`);
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
  logger.debug("All connections closed");
}
