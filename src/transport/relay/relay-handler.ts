import { log, error as logError } from "@fenix/logger";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import type { EnvironmentRecord } from "../../repositories/environment";
import { environmentRepo } from "../../repositories/environment";
import { getAgentConfigById } from "../../services/config/agent-config";
import { resolveWorkspacePath } from "../../services/workspace-resolver";
import type { RelayConnectionEntry } from "../../types/store";
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

/** relay 设置期间（openLocalRelay 尚未完成）缓存前端消息 */
const pendingRelayMessages = new Map<string, Array<Record<string, unknown>>>();

// ────────────────────────────────────────────
// Relay open / close / message handlers
// ────────────────────────────────────────────

/** Called from onOpen — unified relay path through CoreRuntimeFacade */
export async function handleRelayOpen(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId?: string,
): Promise<void> {
  log(`Relay connection opened: relayWsId=${relayWsId} agentId=${agentId}`);

  // 在异步设置开始前注册 pending buffer，避免前端消息被丢弃
  pendingRelayMessages.set(relayWsId, []);

  let env: EnvironmentRecord | undefined;
  try {
    env = await environmentRepo.getById(agentId);
  } catch (err) {
    pendingRelayMessages.delete(relayWsId);
    throw err;
  }
  if (!env) {
    pendingRelayMessages.delete(relayWsId);
    sendToRelayWs(ws, { type: "error", payload: { message: "Environment not found" } });
    ws.close(4004, "environment not found");
    return;
  }

  // 查 agentConfig 获取 agentPrompt
  let agentPrompt: string | undefined;
  if (env.agentConfigId) {
    const agentCfg = await getAgentConfigById(env.agentConfigId);
    agentPrompt = (agentCfg?.prompt as string) ?? undefined;
    // 缓存 machineId 供 session 消息路由使用
    if (agentCfg?.machineId) {
      setAgentMachineCache(agentId, agentCfg.machineId);
    }
  }

  // 统一走 openLocalRelay（通过 ensureRunning → facade），本地和远程均由 core 调度
  await openLocalRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, env, agentPrompt);
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
    log(`Local instance ${result.status}: instanceId=${instanceId} envId=${agentId}`);
  } catch (err) {
    pendingRelayMessages.delete(relayWsId);
    const msg = err instanceof Error ? err.message : String(err);
    sendToRelayWs(ws, { type: "error", payload: { message: `Failed to start local instance: ${msg}` } });
    ws.close(1011, "spawn failed");
    return;
  }

  // WS 已关闭则放弃
  if (ws.readyState !== 1) {
    pendingRelayMessages.delete(relayWsId);
    return;
  }

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
      pendingRelayMessages.delete(relayWsId);
      try {
        handle.close(1000, "ws closed during setup");
      } catch {
        /* ignore */
      }
      return;
    }
  } catch (err) {
    pendingRelayMessages.delete(relayWsId);
    const msg = err instanceof Error ? err.message : String(err);
    logError("Failed to connect instance relay:", err);
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
    workspacePath: resolveWorkspacePath(_env.organizationId ?? userId, userId, _env.id),
  };
  manager.add(relayWsId, entry);

  // 4. 先发送 relay 层的 status（携带 agent_prompt），再注册 onMessage
  //    确保前端先收到连接就绪信号，再收到 agent 的 capabilities
  sendToRelayWs(ws, { type: "status", payload: { connected: true, agent_prompt: agentPrompt ?? null } });
  log("Relay → frontend status", { relayWsId, agentId, instanceId, connected: true });
  log(`Local relay established: relayWsId=${relayWsId} agentId=${agentId} instanceId=${instanceId}`);

  const full = handle as FullRelayHandle;
  if (full.onMessage) {
    entry.relayUnsub = full.onMessage((message) => {
      // 转发 agent 的 status（含 capabilities），使前端能检测 session/list 等能力
      if ((message as Record<string, unknown>).type === "status") {
        log("Relay ← agent status", { relayWsId, agentId, instanceId, payload: JSON.stringify(message).slice(0, 300) });
        sendToRelayWs(ws, message);
        return;
      }
      if ((message as Record<string, unknown>).type === "relay_closed") {
        log("Relay ← agent relay_closed", { relayWsId, agentId, instanceId });
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

  // 5. 回放设置期间缓存的前端消息（connect、new_session 等）
  const pending = pendingRelayMessages.get(relayWsId) ?? [];
  pendingRelayMessages.delete(relayWsId);
  if (pending.length > 0) {
    log(`Flushing ${pending.length} pending message(s) for relayWsId=${relayWsId}`);
    for (const msg of pending) {
      try {
        log("Relay → agent (pending flush)", { relayWsId, agentId, instanceId, msgType: msg.type });
        entry.relayHandle!.send(msg as { type: string; payload?: unknown });
      } catch (err) {
        logError("Failed to send buffered message:", err);
      }
    }
  }

  // 6. 对齐本地路径：补发 connect 触发 agent 回传 status（含 capabilities）
  //    本地路径中 acp-link server handleConnect 会自动推送 capabilities，
  //    远程路径依赖 dispatcher.handleTransportMessage("connect") 回传。
  //    如果前端的 connect 在 agent start 完成前被 flush，dispatcher 未创建，
  //    capabilities 不会回传。这里额外发一次确保前端一定能收到 capabilities。
  try {
    log("Relay → agent connect", { relayWsId, agentId, instanceId });
    entry.relayHandle!.send({ type: "connect" });
  } catch {
    /* relay handle 可能还没 ready，忽略 */
  }
}

/** Called from onMessage — forwards frontend messages */
export async function handleRelayMessage(
  ws: WsConnection,
  relayWsId: string,
  data: string | Record<string, unknown>,
): Promise<void> {
  // relay 设置尚未完成时，缓存消息等待 flush
  if (pendingRelayMessages.has(relayWsId)) {
    let parsed: Record<string, unknown>;
    if (typeof data === "string") {
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
    } else {
      parsed = data;
    }
    if (parsed.type === "ping") {
      sendToRelayWs(ws, { type: "pong" });
      return;
    }
    if (parsed.type === "keep_alive") return;
    pendingRelayMessages.get(relayWsId)!.push(parsed);
    return;
  }

  const entry = manager.get(relayWsId);
  if (!entry) return;

  let parsed: Record<string, unknown>;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      logError("parse error:", data.substring(0, 120));
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

  // 通过 CoreRuntimeFacade relay handle 发送（本地和远程统一）
  if (entry.relayHandle) {
    // JSON-RPC 消息（无 type 字段）直接放行，不受 sessionStarted 约束
    const isJsonRpc = (parsed as Record<string, unknown>).jsonrpc === "2.0";
    if (!entry.sessionStarted && !isJsonRpc && parsed.type !== "list_sessions") {
      entry.outboundBuffer.push(parsed);
      return;
    }
    // 本地 agent：注入 workspace cwd（远程 agent 由 AcpDispatcher 处理）
    if (isJsonRpc && entry.workspacePath) {
      const method = parsed.method as string | undefined;
      if (
        method === "session/new" ||
        method === "session/list" ||
        method === "session/load" ||
        method === "session/resume"
      ) {
        const params = (parsed.params ?? {}) as Record<string, unknown>;
        params.cwd = entry.workspacePath;
        parsed.params = params;
      }
    }
    try {
      log("Relay → agent", {
        relayWsId,
        agentId: entry.agentId,
        instanceId: entry.instanceId,
        msgType: parsed.type,
        payload: JSON.stringify(parsed).slice(0, 300),
      });
      entry.relayHandle.send(parsed as { type: string; payload?: unknown });
    } catch (err) {
      logError("relay handle send error:", err);
      sendToRelayWs(ws, { type: "error", payload: { message: "Agent connection error" } });
      ws.close(1011, "relay send failed");
    }
    return;
  }
}

/** Called from onClose — cleans up relay connection */
export function handleRelayClose(_ws: WsConnection, relayWsId: string, code?: number, _reason?: string): void {
  // 清理 pending buffer（设置期间关闭的情况）
  pendingRelayMessages.delete(relayWsId);

  const entry = manager.get(relayWsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(
    `Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? "none"} duration=${duration}s`,
  );

  // 关闭 relay handle
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
  log("Relay → remote session_end", { instanceId });
  sendToWs(entry.ws, { type: "session_end", session_id: `auto_${instanceId}` });
}

/** 向指定 machine 的 relay 发送数据 */
export function sendToInstanceRelay(instanceId: string, data: string): boolean {
  const entry = findMachineConnectionById(instanceId);
  if (!entry) return false;
  try {
    const parsed = JSON.parse(data);
    log("Relay → remote session_data", {
      instanceId,
      payloadType: parsed.type,
      payload: JSON.stringify(parsed).slice(0, 300),
    });
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

/** machine 断连后清理关联的 relay 连接：关闭前端 WS 让前端感知断连 */
export function handleMachineDisconnected(machineId: string): void {
  for (const [relayWsId, entry] of manager.entries()) {
    // 匹配条件：instanceId 等于 machineId（远程实例的 instanceId 即为 machineId）
    if (entry.instanceId !== machineId) continue;
    log(`[ACP-Relay] Machine ${machineId} disconnected, closing relay ${relayWsId}`);
    try {
      entry.relayHandle?.close(1011, "machine disconnected");
    } catch {
      /* ignore */
    }
    entry.relayUnsub?.();
    if (entry.ws.readyState === 1) {
      sendToRelayWs(entry.ws, { type: "error", payload: { message: "Machine disconnected" } });
      try {
        entry.ws.close(1011, "machine disconnected");
      } catch {
        /* ignore */
      }
    }
    clearInterval(entry.keepalive!);
    manager.remove(relayWsId);
  }
}
