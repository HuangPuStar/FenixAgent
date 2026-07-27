import { log, error as logError } from "@fenix/logger";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import { AppError } from "../../errors";
import type { EnvironmentRecord } from "../../repositories/environment";
import { environmentRepo } from "../../repositories/environment";
import {
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  touchInstanceActivity,
} from "../../services/acp-idle-monitor";
import { getAgentConfigById } from "../../services/config/agent-config";
import { getCoreRuntime } from "../../services/core-bootstrap";
import {
  closeSession,
  openChat,
  openSession,
  processACP,
  registerSession,
  setChatAgentInfo,
  setChatConnectionStatus,
} from "../../services/session-state-service";
import { resolveWorkspacePath } from "../../services/workspace-resolver";
import type { RelayConnectionEntry } from "../../types/store";
import { findMachineConnectionById, getAgentMachineCache, sendToWs, setAgentMachineCache } from "../acp-ws-handler";
import { connectAgentRelay } from "../agent-relay";
import type { WsConnection } from "../ws-types";
import { RelayConnectionManager, sendToRelayWs } from "./connection-manager";
import { filterConnectFromFlush } from "./message-router";

/** OpencodeRelayHandle extends EngineRelayHandle with onMessage/ready */
type FullRelayHandle = EngineRelayHandle & {
  onMessage?: (listener: (message: { type: string; payload?: unknown }) => void) => () => void;
  ready?: Promise<void>;
};

const manager = new RelayConnectionManager();

const RELAY_KEEPALIVE_INTERVAL_MS = 20_000;
const RELAY_NO_RECONNECT_CLOSE_CODE = 1000;
const IDLE_RECLAIM_CLOSE_REASON = "instance_idle_reclaimed";

// ── Yjs 迁移：前端不再需要原始 ACP 内容事件转发 ──
// 消息内容（agent_message_chunk / tool_call 等）已通过 Y.Doc → yjs:update 广播推送。
// 仅保留前端 ACPProtocol 仍使用的传输层类型 + JSON-RPC 消息。
const FORWARD_TYPES = new Set(["status", "error", "prompt_complete", "permission_request", "interactive_question"]);

function shouldForwardToFrontend(msgType: string | undefined, message: unknown): boolean {
  // Yjs 广播消息不在此路径（由 setYjsUpdateHandler 单独广播）
  if ((message as Record<string, unknown>)?.type === "yjs:update") return false;
  // JSON-RPC 消息（session/new, session/list 等）仍需转发
  if ((message as Record<string, unknown>)?.jsonrpc === "2.0") return true;
  // 传输层白名单
  return msgType != null && FORWARD_TYPES.has(msgType);
}

/** relay 设置期间（openLocalRelay 尚未完成）缓存前端消息 */
const pendingRelayMessages = new Map<string, Array<Record<string, unknown>>>();

// ── JSON-RPC 兼容提取 ──
// EngineRelay 消息可能是 raw { type, payload } 或 JSON-RPC { jsonrpc: "2.0", ... } 两种格式。
// session/update 通知中的实际 ACP 事件在 params.update 内。

/** 从消息中提取 JSON-RPC 对象（兼容原始和包裹两种格式） */
export function extractJsonRpc(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (msg.jsonrpc === "2.0") return msg;
  const payload = msg.payload as Record<string, unknown> | undefined;
  if (payload?.jsonrpc === "2.0") return payload;
  return null;
}

/**
 * 从 EngineRelay 消息中提取 ACP 事件类型和载荷。
 * 兼容两种消息格式：
 * 1. 原始引擎格式: { type: "agent_message_chunk", payload: { type: "text", text: "..." } }
 * 2. JSON-RPC session/update: { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "...", content: {...} } } }
 *    （含包裹格式: { type: "session_data", payload: { jsonrpc: "2.0", ... } }）
 */
export function extractAcpEvent(
  rawMessage: unknown,
  msgType: string | undefined,
): { type: string; payload?: Record<string, unknown> } {
  const message = rawMessage as Record<string, unknown>;
  // 1. 尝试 JSON-RPC session/update 通知提取
  const rpc = extractJsonRpc(message);
  if (rpc && rpc.method === "session/update") {
    const params = rpc.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (update?.sessionUpdate) {
      return {
        type: update.sessionUpdate as string,
        payload: update as Record<string, unknown>,
      };
    }
  }

  // 1.5. JSON-RPC 响应中的 prompt 结果：
  // session-manager 的 JSON-RPC 路径可能将 prompt 结果包装为
  //   createSuccessResponse(id, result) → { jsonrpc: "2.0", result: { stopReason: ... } }
  // 当 session_data payload 是此类 JSON-RPC 响应时，提取为 prompt_complete。
  if (rpc && "result" in rpc) {
    const result = rpc.result as Record<string, unknown> | undefined;
    if (result && typeof result === "object" && "stopReason" in result) {
      return {
        type: "prompt_complete",
        payload: result,
      };
    }
  }

  // 2. session_data 包裹格式：{ type: "session_data", payload: { type: "prompt_complete", payload: ... } }
  // session-manager 将 prompt_complete 等非 JSON-RPC 事件通过
  //   emit(sessionId, "session_data", { type: "prompt_complete", payload: result })
  // 发送。需要提取内部嵌套 type，否则 applyACPEvent 收到 type="session_data" 无法匹配任何 handler。
  // 注意：msgType 为 "session_data" 但 payload 为 JSON-RPC 对象的情况已在步骤 1 处理并返回。
  const innerPayload = message.payload as Record<string, unknown> | undefined;
  if (msgType === "session_data" && innerPayload?.type && typeof innerPayload.type === "string") {
    return {
      type: innerPayload.type as string,
      payload: (innerPayload.payload as Record<string, unknown>) ?? innerPayload,
    };
  }

  // 3. 回退：原始 EngineRelayMessage 格式 { type, payload }
  return {
    type: msgType || "unknown",
    payload: innerPayload ?? message,
  };
}

// ── 简单 JSON 命令 → ACP JSON-RPC 翻译 ──
// 前端休克疗法后改用 { action, ... } 格式，此处翻译回 ACP JSON-RPC。

export function translateSimpleAction(
  parsed: Record<string, unknown>,
  workspacePath?: string | null,
): Record<string, unknown> {
  const action = parsed.action as string;
  switch (action) {
    case "send_prompt":
      return { jsonrpc: "2.0", method: "session/prompt", params: { content: parsed.content } };
    case "cancel":
      return { jsonrpc: "2.0", method: "session/cancel", params: {} };
    case "create_session":
      return { jsonrpc: "2.0", method: "session/new", params: { cwd: workspacePath } };
    case "load_session":
      return {
        jsonrpc: "2.0",
        method: "session/load",
        params: { sessionId: parsed.sessionId, cwd: workspacePath },
      };
    case "resume_session":
      return {
        jsonrpc: "2.0",
        method: "session/resume",
        params: { sessionId: parsed.sessionId, cwd: workspacePath },
      };
    case "list_sessions":
      return { jsonrpc: "2.0", method: "session/list", params: {} };
    case "rename_session":
      return {
        jsonrpc: "2.0",
        method: "session/rename",
        params: { sessionId: parsed.sessionId, title: parsed.title },
      };
    case "delete_session":
      return {
        jsonrpc: "2.0",
        method: "session/delete",
        params: { sessionId: parsed.sessionId },
      };
    case "respond_permission":
      return {
        jsonrpc: "2.0",
        method: "session/permission",
        params: { requestId: parsed.requestId, optionId: parsed.optionId },
      };
    default:
      return parsed;
  }
}

// ── Yjs 会话列表同步 ──
// 拦截 agent→client 的 session/list 和 session/new JSON-RPC 响应，
// 将 sessions 数据写入 Yjs Chat Doc，实现前端会话列表的实时同步。

function trySyncSessionsToYjs(entry: RelayConnectionEntry, message: unknown): void {
  try {
    // 兼容两种 JSON-RPC 消息格式：
    //   原始格式：{ jsonrpc: "2.0", result: { ... }, id: 1 }
    //   包裹格式：{ type: "...", payload: { jsonrpc: "2.0", result: { ... }, id: 1 } }
    let rpc: Record<string, unknown> | undefined;

    {
      const msg = message as Record<string, unknown>;
      if (msg.jsonrpc === "2.0") {
        rpc = msg;
      } else {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (payload?.jsonrpc === "2.0") rpc = payload;
      }
    }

    if (!rpc || !("result" in rpc)) return;

    const result = rpc.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== "object") return;

    // session/new — 追加单个新会话
    const newSessionId = result.sessionId;
    if (typeof newSessionId === "string" && newSessionId.length > 0) {
      registerSession(entry.userId, entry.agentId, {
        sessionId: newSessionId,
        title: "",
        preview: "",
        status: "active",
        lastMsgTs: Date.now(),
      });
      return;
    }

    // session/list — 批量同步会话列表
    const sessions = result.sessions as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(sessions)) return;

    for (const s of sessions) {
      const sid = s.sessionId as string | undefined;
      if (!sid) continue;
      // updatedAt 校验：非法日期字符串（如 "invalid"）会生成 NaN，
      // new Date(...).getTime() 结果需用 || 兜底避免写入 NaN 到 Yjs
      const ts = s.updatedAt ? new Date(s.updatedAt as string).getTime() : 0;
      registerSession(entry.userId, entry.agentId, {
        sessionId: sid,
        title: (s.title as string) || "",
        preview: "",
        status: "active",
        lastMsgTs: ts > 0 ? ts : Date.now(),
      });
    }
  } catch {
    // 解析失败静默忽略，不影响 relay 转发
  }
}

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
    const result = await ensureRunning(userId, agentId, "interactive");
    instanceId = result.instance.id;
    log(`Local instance ${result.status}: instanceId=${instanceId} envId=${agentId}`);
  } catch (err) {
    pendingRelayMessages.delete(relayWsId);
    const msg = err instanceof Error ? err.message : String(err);
    // 远程节点不可用：使用 4500 关闭码，前端不自动重连，等用户手动点击重连
    // 其他 spawn 失败保持 1011，前端可自动重连（可能是临时故障）
    if (err instanceof AppError && err.code === "MACHINE_OFFLINE") {
      log(`Relay rejected: machine offline agentId=${agentId}`);
      sendToRelayWs(ws, { type: "error", payload: { code: "machine_unavailable", message: msg } });
      ws.close(4500, "machine offline");
      return;
    }
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
    handle = await connectAgentRelay(instanceId, sessionId);

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
    if (entry?.ws.readyState !== 1) {
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
    workspacePath: resolveWorkspacePath(_env.organizationId ?? userId, _env.userId ?? userId, _env.id),
  };
  manager.add(relayWsId, entry);
  if (instanceId) {
    markInstanceRelayAttached(instanceId);
  }

  // 5. 初始化 Chat/Session Doc 用于 ACP 状态聚合
  try {
    await openChat(userId, agentId);
    setChatConnectionStatus(userId, agentId, { status: "connected", since: Date.now() });
    setChatAgentInfo(userId, agentId, {
      id: agentId,
      name: agentPrompt?.slice(0, 50) ?? agentId,
    });
    await openSession(userId, agentId, sessionId);
  } catch (err) {
    logError("[relay] Failed to init session-state:", err);
  }

  // 4. 先发送 relay 层的 status（携带 agent_prompt），再注册 onMessage
  //    确保前端先收到连接就绪信号，再收到 agent 的 capabilities
  sendToRelayWs(ws, { type: "status", payload: { connected: true, agent_prompt: agentPrompt ?? null } });
  log("Relay → frontend status", { relayWsId, agentId, instanceId, connected: true });
  log(`Local relay established: relayWsId=${relayWsId} agentId=${agentId} instanceId=${instanceId}`);

  const full = handle as FullRelayHandle;
  if (full.onMessage) {
    entry.relayUnsub = full.onMessage((message) => {
      const msgType = (message as unknown as Record<string, unknown>).type as string | undefined;
      // 转发 agent 的 status（含 capabilities），使前端能检测 session/list 等能力
      if (msgType === "status") {
        log("Relay ← agent status", { relayWsId, agentId, instanceId, payload: JSON.stringify(message).slice(0, 300) });
        sendToRelayWs(ws, message);
        return;
      }
      if (msgType === "relay_closed") {
        log("Relay ← agent relay_closed", { relayWsId, agentId, instanceId });
        const currentEntry = manager.get(relayWsId);
        if (currentEntry?.closingReason === "idle_reclaim") {
          log(`[ACP-Relay] Ignoring relay_closed fallback for idle reclaim relayWsId=${relayWsId}`);
          return;
        }
        sendToRelayWs(ws, {
          type: "error",
          payload: { message: "Agent connection lost" },
        });
        ws.close(1011, "relay handle closed");
        return;
      }
      if (entry.instanceId && typeof msgType === "string" && msgType !== "status") {
        touchInstanceActivity(entry.instanceId, message as unknown as Record<string, unknown>);
      }
      const e = manager.get(relayWsId);
      if (!e) {
        logError("Relay ← agent: entry not found in manager", { relayWsId, agentId, instanceId, msgType });
        return;
      }
      if (e.ws.readyState !== 1) {
        logError("Relay ← agent: frontend WS not open", {
          relayWsId,
          agentId,
          instanceId,
          msgType,
          readyState: e.ws.readyState,
        });
        return;
      }
      // 同步会话列表到 Yjs Chat Doc（旁路，不影响转发）
      trySyncSessionsToYjs(e, message);
      // 聚合 ACP 事件到 Session Doc（旁路，不影响转发）
      try {
        processACP(e.sessionId, extractAcpEvent(message, msgType));
      } catch {
        // 聚合失败不影响 relay 转发
      }
      // Yjs 迁移后，消息内容通过 yjs:update 广播推送，不再转发原始 ACP 事件到前端。
      // 仅保留前端仍需要的传输层消息类型。
      if (shouldForwardToFrontend(msgType, message)) {
        sendToRelayWs(e.ws, message);
      }
    });
  }

  // 5. 回放设置期间缓存的前端消息（connect、new_session 等）
  //    过滤 connect：relay handle 在 onopen 时已自动发送 connect，
  //    若不过滤会导致 agent 回传多余的 status，触发前端 resendPending() 重复发请求。
  const pending = pendingRelayMessages.get(relayWsId) ?? [];
  pendingRelayMessages.delete(relayWsId);
  const filteredPending = filterConnectFromFlush(pending);
  if (filteredPending.length > 0) {
    log(`Flushing ${filteredPending.length} pending message(s) for relayWsId=${relayWsId}`);
    for (const msg of filteredPending) {
      try {
        log("Relay → agent (pending flush)", { relayWsId, agentId, instanceId, msgType: msg.type });
        entry.relayHandle!.send(msg as { type: string; payload?: unknown });
      } catch (err) {
        logError("Failed to send buffered message:", err);
      }
    }
  }

  // 6. 补发 connect 触发 agent 回传 status（含 capabilities）
  //    relay handle 的 onopen 已经发送过 connect，此处仅作安全兜底：
  //    如果 relay handle 的 connect 在 agent start 之前被处理，dispatcher 未创建，
  //    capabilities 不会回传。这里额外发一次确保前端一定能收到 capabilities。
  //    注意：仅在 agent 尚未推送过 status 时发送，避免重复 status 触发前端 resendPending。
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
    // ── 简单 JSON 命令 → ACP JSON-RPC 翻译 ──
    // 前端休克疗法后不再发送 ACP JSON-RPC，改用 { action, ... } 格式。
    // 此处将其翻译为 ACP JSON-RPC 再转发给 agent。
    const action = parsed.action as string | undefined;
    if (action) {
      parsed = translateSimpleAction(parsed, entry.workspacePath);
    }

    // JSON-RPC 消息（无 type 字段）直接放行，不受 sessionStarted 约束
    const isJsonRpc = (parsed as Record<string, unknown>).jsonrpc === "2.0";
    if (!entry.sessionStarted && !isJsonRpc && parsed.type !== "list_sessions") {
      entry.outboundBuffer.push(parsed);
      return;
    }
    // 只在本地 agent 注入 workspace cwd；远程 agent 由远程机器自己管理 workspace
    const isRemote = getAgentMachineCache().has(entry.agentId);
    if (isJsonRpc && entry.workspacePath && !isRemote) {
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
      if (entry.instanceId) {
        touchInstanceActivity(entry.instanceId, parsed);
      }
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

  if (entry.instanceId) {
    markInstanceRelayDetached(entry.instanceId);
  }

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(
    `Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? "none"} duration=${duration}s`,
  );

  // 关闭 relay handle — 仅断开事件订阅，不关闭远程 agent 连接
  // 前端刷新时 relay 断连不应终止远程实例，前端重连后应能复用
  if (entry.relayHandle) {
    entry.relayUnsub?.();
  }

  // 当前端 relay 全部断开时，通知 agent 侧立即取消所有待决权限请求，
  // 避免 agent 中 requestPermission 的 pending Promise 等待 30s 超时才返回 cancelled。
  if (entry.instanceId && entry.relayHandle && !manager.hasOtherRelayForInstance(entry.instanceId, relayWsId)) {
    try {
      entry.relayHandle.send({ type: "cancel_pending_permissions" });
    } catch (err) {
      logError("handleRelayClose: failed to send cancel_pending_permissions", err);
    }
  }

  // 清理 Session Doc 和连接状态
  closeSession(entry.sessionId).catch(() => {});
  setChatConnectionStatus(entry.userId, entry.agentId, {
    status: "disconnected",
    since: Date.now(),
  });

  manager.remove(relayWsId);
}

/** 因实例被回收而主动关闭关联的前端 relay，阻止前端自动重连。 */
export function closeRelayConnectionsForIdleReclaim(instanceId: string): void {
  for (const [relayWsId, entry] of manager.entries()) {
    if (entry.instanceId !== instanceId) continue;

    log(`[ACP-Relay] Closing relay ${relayWsId} for idle reclaim instanceId=${instanceId} agentId=${entry.agentId}`);

    entry.closingReason = "idle_reclaim";
    entry.relayUnsub?.();
    entry.relayUnsub = null;

    try {
      entry.relayHandle?.close(RELAY_NO_RECONNECT_CLOSE_CODE, IDLE_RECLAIM_CLOSE_REASON);
    } catch {
      /* ignore */
    }

    if (entry.ws.readyState === 1) {
      sendToRelayWs(entry.ws, {
        type: "error",
        payload: { code: IDLE_RECLAIM_CLOSE_REASON, message: IDLE_RECLAIM_CLOSE_REASON },
      });
      try {
        entry.ws.close(RELAY_NO_RECONNECT_CLOSE_CODE, IDLE_RECLAIM_CLOSE_REASON);
      } catch {
        /* ignore */
      }
    }

    clearInterval(entry.keepalive!);
    if (entry.instanceId) {
      markInstanceRelayDetached(entry.instanceId);
    }
    manager.remove(relayWsId);
  }
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
  closeRelayByMachine(machineId, "machine disconnected");
}

/**
 * machine 重连后关闭关联的旧 relay 连接，让前端自动重连并触发 ensureRunning。
 * 这确保新的 relay handle 使用新的 transport（而非旧的断连 transport）。
 */
export function handleMachineReconnect(machineId: string): void {
  closeRelayByMachine(machineId, "machine reconnected");
}

function closeRelayByMachine(machineId: string, reason: string): void {
  // 查找运行在目标 machine 上的所有实例 ID，用于匹配 relay 连接
  // 注意：调用方可能已经通过 unregisterRemoteNode 删除了 core 中的实例，
  // 所以需要同时用 agentMachineCache（agentId → machineId）做兜底匹配
  const facade = getCoreRuntime();
  const instanceIdsOnMachine = new Set<string>();
  if (facade) {
    for (const inst of facade.listInstances()) {
      if (inst.nodeId === machineId) instanceIdsOnMachine.add(inst.instanceId);
    }
  }
  // 兜底：通过 agentMachineCache 匹配（unregisterRemoteNode 不清此缓存）
  const machineCache = getAgentMachineCache();

  log(
    `[ACP-Relay] closeRelayByMachine: machineId=${machineId} reason=${reason} instancesOnMachine=[${[...instanceIdsOnMachine].join(",")}] relayEntries=${manager.size}`,
  );

  for (const [relayWsId, entry] of manager.entries()) {
    // 匹配条件：instanceId 在 core 实例列表中，或 agentId 的 machineId 缓存匹配
    const matchByInstance = instanceIdsOnMachine.has(entry.instanceId ?? "");
    const matchByCache = machineCache.get(entry.agentId) === machineId;
    if (!matchByInstance && !matchByCache) continue;
    log(
      `[ACP-Relay] Closing relay ${relayWsId} (${reason}) instanceId=${entry.instanceId} agentId=${entry.agentId} match=${matchByInstance ? "instance" : "cache"}`,
    );
    try {
      entry.relayHandle?.close(4500, reason);
    } catch {
      /* ignore */
    }
    entry.relayUnsub?.();
    // 4500 = 远程节点不可用，前端不自动重连，等用户手动点击
    if (entry.ws.readyState === 1) {
      sendToRelayWs(entry.ws, { type: "error", payload: { code: "machine_unavailable", message: reason } });
      try {
        entry.ws.close(4500, reason);
      } catch {
        /* ignore */
      }
    }
    clearInterval(entry.keepalive!);
    if (entry.instanceId) {
      markInstanceRelayDetached(entry.instanceId);
    }
    manager.remove(relayWsId);
  }
}

// ── Yjs 广播：将所有 Y.Doc 的变更推送给前端 ──
import { setYjsUpdateHandler } from "../../services/session-state-service";

setYjsUpdateHandler((docName: string, update: Uint8Array) => {
  const base64 = Buffer.from(update).toString("base64");
  for (const [, entry] of manager.entries()) {
    try {
      sendToRelayWs(entry.ws, {
        type: "yjs:update",
        docName,
        data: base64,
      });
    } catch {
      // 单个连接发送失败不影响其他
    }
  }
});
