import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import { log, error as logError } from "../../logger";
import type { EnvironmentRecord } from "../../repositories/environment";
import { environmentRepo } from "../../repositories/environment";
import { getAgentConfigById } from "../../services/config/agent-config";
import type { AcpConnectionEntry, RelayConnectionEntry } from "../../types/store";
import { findMachineConnectionById, sendToWs, setAgentMachineCache } from "../acp-ws-handler";
import type { WsConnection } from "../ws-types";
import { RelayConnectionManager, sendToRelayWs } from "./connection-manager";

/** OpencodeRelayHandle extends EngineRelayHandle with onMessage/ready */
type FullRelayHandle = EngineRelayHandle & {
  onMessage?: (listener: (message: { type: string; payload?: unknown }) => void) => () => void;
  ready?: Promise<void>;
};

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

  // 查 agentConfig 获取 machineId 和 agentPrompt（两条路径共用）
  let machineId: string | null = null;
  let agentPrompt: string | undefined;
  if (env.agentConfigId) {
    const agentCfg = await getAgentConfigById(env.agentConfigId);
    machineId = agentCfg?.machineId ?? null;
    agentPrompt = (agentCfg?.prompt as string) ?? undefined;
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
    openMachineRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, machineConn, agentPrompt, env);
  } else {
    // 本地路径（默认 machine）
    await openLocalRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, env, agentPrompt);
  }
}

async function openLocalRelay(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId: string,
  _env: EnvironmentRecord,
  agentPrompt?: string,
): Promise<void> {
  const { ensureRunning } = await import("../../services/instance");

  // 1. 确保实例运行
  let instanceId: string;
  try {
    const result = await ensureRunning(userId, agentId);
    instanceId = result.instance.id;
    log(`[ACP-Relay] Local instance ${result.status}: instanceId=${instanceId} envId=${agentId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendToRelayWs(ws, { type: "error", payload: { message: `Failed to start local instance: ${msg}` } });
    ws.close(1011, "spawn failed");
    return;
  }

  // WS 已关闭则放弃
  if (ws.readyState !== 1) return;

  // 2. 通过 CoreRuntimeFacade 连接 relay handle（先不加入 manager，避免空窗期路由错误）
  let handle: EngineRelayHandle;
  try {
    const { getCoreRuntime } = await import("../../services/core-bootstrap");
    const facade = getCoreRuntime();
    handle = await facade.connectInstanceRelay({ instanceId, sessionId });

    const full = handle as FullRelayHandle;
    if (full.ready) await full.ready;

    // WS 在 await 期间关闭 → 清理 handle 并放弃
    if (ws.readyState !== 1) {
      try {
        handle.close(1000, "ws closed during setup");
      } catch {
        /* ignore */
      }
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("[ACP-Relay] Failed to connect instance relay:", err);
    sendToRelayWs(ws, { type: "error", payload: { message: `Relay connect failed: ${msg}` } });
    ws.close(1011, "relay connect failed");
    return;
  }

  // 3. 所有异步工作完成，一次性创建完整 entry 并加入 manager
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
    relayHandle: handle,
    relayUnsub: null,
    sessionId,
    outboundBuffer: [],
    sessionStarted: true,
  };
  manager.add(relayWsId, entry);

  // 4. 注册 onMessage（flush relay handle 内部缓冲的消息）
  const full = handle as FullRelayHandle;
  if (full.onMessage) {
    entry.relayUnsub = full.onMessage((message) => {
      if (message.type === "status") return; // 由本层发送 status
      if (message.type === "relay_closed") {
        sendToRelayWs(ws, {
          type: "error",
          payload: { message: "Agent connection lost" },
        });
        ws.close(1011, "relay handle closed");
        return;
      }
      const e = manager.get(relayWsId);
      if (!e || e.ws.readyState !== 1) return;
      sendToRelayWs(e.ws, message);
    });
  }

  // 5. 通知前端连接就绪（携带 agent_prompt）
  sendToRelayWs(ws, { type: "status", payload: { connected: true, agent_prompt: agentPrompt ?? null } });
  log(`[ACP-Relay] Local relay established: relayWsId=${relayWsId} agentId=${agentId} instanceId=${instanceId}`);
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
    sessionId,
    outboundBuffer: [],
    sessionStarted: false, // 等待 session_started 确认
  };
  manager.add(relayWsId, entry);

  // 注册 per-session 消息回调（替代旧的链式 onSessionMessage 覆盖）
  const sessionCallback = (_msgSessionId: string, type: string, payload: unknown) => {
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
        sendToRelayWs(ws, payload as object);
        break;
      case "session_ended":
      case "session_error":
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

  // 初始化 sessionMessageListeners（如果不存在）
  if (!machineConn.sessionMessageListeners) {
    machineConn.sessionMessageListeners = new Map();
  }
  machineConn.sessionMessageListeners.set(sessionId, sessionCallback);

  // 发送 session_start 到 machine WS（携带完整 launch spec）
  buildAndSendSessionStart(machineConn.ws, sessionId, agentId, userId, agentPrompt, env);

  // 超时处理：10s 内未收到 session_started 或 session_queued，则失败
  const spawnTimeout = setTimeout(() => {
    const e = manager.get(relayWsId);
    if (e && !e.sessionStarted) {
      log(`[ACP-Relay] session_start timeout for ${relayWsId}`);
      sendToRelayWs(ws, { type: "error", payload: { message: "Agent spawn timeout" } });
      ws.close(1011, "spawn timeout");
      sendToWs(machineConn.ws, { type: "session_end", session_id: sessionId });
      machineConn.sessionMessageListeners?.delete(sessionId);
      machineConn.sessionMessageListeners?.delete(`_timeout_${sessionId}`);
      manager.remove(relayWsId);
    }
  }, 10000);

  // session_started/session_queued/session_error 清除超时
  const timeoutClearCallback = (_msgSessionId: string, type: string, _payload: unknown) => {
    if (type === "session_started" || type === "session_queued" || type === "session_error") {
      clearTimeout(spawnTimeout);
      machineConn.sessionMessageListeners?.delete(`_timeout_${sessionId}`);
    }
  };
  machineConn.sessionMessageListeners.set(`_timeout_${sessionId}`, timeoutClearCallback);

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

  // 本地路径：通过 CoreRuntimeFacade relay handle 发送
  if (entry.relayHandle) {
    if (!entry.sessionStarted && parsed.type !== "list_sessions") {
      entry.outboundBuffer.push(parsed);
      return;
    }
    try {
      entry.relayHandle.send(parsed as { type: string; payload?: unknown });
    } catch (err) {
      logError("[ACP-Relay] relay handle send error:", err);
      sendToRelayWs(ws, { type: "error", payload: { message: "Agent connection error" } });
      ws.close(1011, "relay send failed");
    }
    return;
  }

  // 远端 machine 路径：通过 machine WS 转发
  if (entry.instanceId) {
    const machineConn = findMachineConnectionById(entry.instanceId);
    if (!machineConn) {
      sendToRelayWs(ws, { type: "error", payload: { message: "Machine offline" } });
      return;
    }

    if (!entry.sessionStarted && parsed.type !== "list_sessions") {
      entry.outboundBuffer.push(parsed);
      return;
    }

    sendToWs(machineConn.ws, {
      type: "session_data",
      session_id: entry.sessionId,
      payload: parsed,
    });
    return;
  }
}

/** Called from onClose — cleans up relay connection */
export function handleRelayClose(_ws: WsConnection, relayWsId: string, code?: number, _reason?: string): void {
  const entry = manager.get(relayWsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(
    `[ACP-Relay] Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? "none"} duration=${duration}s`,
  );

  // 关闭 relay handle（本地路径）
  if (entry.relayHandle) {
    if (entry.instanceId && !manager.hasOtherRelayForInstance(entry.instanceId, relayWsId)) {
      try {
        entry.relayHandle.close(1000, "relay disconnected");
      } catch {
        /* ignore */
      }
    }
    entry.relayUnsub?.();
  }

  // 发送 session_end 到 machine WS（远端路径）并清理 sessionMessageListeners
  if (entry.instanceId && !entry.relayHandle) {
    const machineConn = findMachineConnectionById(entry.instanceId);
    if (machineConn) {
      sendToWs(machineConn.ws, { type: "session_end", session_id: entry.sessionId });
      machineConn.sessionMessageListeners?.delete(entry.sessionId);
      machineConn.sessionMessageListeners?.delete(`_timeout_${entry.sessionId}`);
    }
  }

  manager.remove(relayWsId);
}

// ────────────────────────────────────────────
// Compatibility layer (signatures unchanged)
// ────────────────────────────────────────────

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
      entry.relayUnsub?.();
      if (entry.relayHandle) {
        try {
          entry.relayHandle.close(1001, "server_shutdown");
        } catch {
          /* ignore */
        }
      }
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
    if (entry.instanceId === machineId && !entry.relayHandle) {
      entry.pendingReconnect = true;
      entry.machineWsId = undefined;
      log(`[ACP-Relay] Machine ${machineId} disconnected, relay ${relayWsId} pending reconnect`);
    }
  }
}
