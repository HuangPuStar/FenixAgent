/**
 * YJS Frontend WebSocket Handler — 全新 YJS 专用 WS 端点处理器。
 *
 * 不复用旧 /acp/relay 的任何逻辑。这条 WS 只做三件事：
 *  1. 接收 agent 产出 → processACP → Y.Doc → yjs:update 广播到前端
 *  2. 接收前端简单 JSON 命令 → translateSimpleAction → ACP JSON-RPC → 转发 agent
 *  3. ping/pong/keep_alive 维持连接
 *
 * 不与 ACP JSON-RPC 协议有任何关系。
 *
 * Instance 级别 relay handle 共享：
 * 同一 Agent 的多个前端 WS 连接（如多标签页）共享同一个 relay handle。
 * onMessage 只注册一次，processACP 每个事件只调用一次，避免文本重复。
 */

import { log, error as logError } from "@fenix/logger";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import * as Y from "yjs";
import { AppError } from "../../errors";
import { environmentRepo } from "../../repositories/environment";
import { markInstanceRelayAttached, markInstanceRelayDetached } from "../../services/acp-idle-monitor";
import { getRedisConnection } from "../../services/cache";
import {
  closeSession,
  openChat,
  openSession,
  processACP,
  registerSession,
  setChatActiveSession,
  setChatAgentInfo,
  setChatAvailableCommands,
  setChatCapabilities,
  setChatConnectionStatus,
  setChatModelState,
  setChatModeState,
  setChatTokenUsage,
} from "../../services/session-state-service";
import { resolveWorkspacePath } from "../../services/workspace-resolver";
import type { WsConnection } from "../ws-types";

// ── 本地模块内用的提取函数（取自 relay-handler） ──
import { extractAcpEvent, extractJsonRpc } from "./relay-handler";

/** JSON-RPC 请求 id 计数器（无 id 的请求被当作 notification，agent 不会返回 result） */
let rpcIdSeq = 0;

/**
 * 将前端的简化操作转换为 ACP JSON-RPC 请求。
 * workspacePath 始终由服务端根据已认证的 environment 解析，不能信任浏览器传入的路径。
 */
export function translateSimpleAction(
  parsed: Record<string, unknown>,
  workspacePath?: string | null,
): Record<string, unknown> {
  const action = parsed.action as string;
  const id = ++rpcIdSeq;
  switch (action) {
    case "send_prompt":
      return { jsonrpc: "2.0", id, method: "session/prompt", params: { content: parsed.content } };
    case "cancel":
      return { jsonrpc: "2.0", id, method: "session/cancel", params: {} };
    case "create_session":
      return { jsonrpc: "2.0", id, method: "session/new", params: { cwd: workspacePath } };
    case "load_session":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/load",
        params: { sessionId: parsed.sessionId, cwd: workspacePath },
      };
    case "resume_session":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/resume",
        params: { sessionId: parsed.sessionId, cwd: workspacePath },
      };
    case "list_sessions":
      return { jsonrpc: "2.0", id, method: "session/list", params: { cwd: workspacePath } };
    case "rename_session":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/rename",
        params: { sessionId: parsed.sessionId, title: parsed.title },
      };
    case "delete_session":
      return { jsonrpc: "2.0", id, method: "session/delete", params: { sessionId: parsed.sessionId } };
    case "respond_permission":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/permission",
        params: { requestId: parsed.requestId, optionId: parsed.optionId },
      };
    case "set_session_mode":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/setMode",
        params: { modeId: parsed.modeId },
      };
    default:
      return parsed;
  }
}

/** 从 configOptions 中提取模型选择状态（SDK 0.28+ 无独立 models 字段） */
function extractModelStateFromConfigOptions(
  configOptions: Array<Record<string, unknown>> | undefined,
): { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } | null {
  if (!configOptions) return null;
  const modelOption = configOptions.find((o) => o.type === "select" && (o.id === "model" || o.category === "model"));
  if (!modelOption) return null;
  const rawOptions = modelOption.options as Array<Record<string, unknown>> | undefined;
  const flatOptions = flattenConfigOptions(rawOptions);
  const availableModels = flatOptions.map((o) => ({
    modelId: String(o.value ?? ""),
    name: String(o.name ?? ""),
  }));
  const rawCurrent = String(modelOption.currentValue ?? modelOption.value ?? "");
  const currentModelId = availableModels.some((m) => m.modelId === rawCurrent)
    ? rawCurrent
    : (availableModels[0]?.modelId ?? rawCurrent);
  return { currentModelId, availableModels };
}

/** 从 configOptions 中提取 mode 选择状态 */
function extractModeStateFromConfigOptions(configOptions: Array<Record<string, unknown>> | undefined): {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string | null }>;
} | null {
  if (!configOptions) return null;
  const modeOption = configOptions.find((o) => o.type === "select" && (o.id === "mode" || o.category === "mode"));
  if (!modeOption) return null;
  const rawOptions = modeOption.options as Array<Record<string, unknown>> | undefined;
  const flatOptions = flattenConfigOptions(rawOptions);
  const availableModes = flatOptions.map((o) => ({
    id: String(o.value ?? ""),
    name: String(o.name ?? ""),
    description: (o.description as string) ?? null,
  }));
  const rawCurrent = String(modeOption.currentValue ?? modeOption.value ?? "");
  const currentModeId = availableModes.some((m) => m.id === rawCurrent)
    ? rawCurrent
    : (availableModes[0]?.id ?? rawCurrent);
  return { currentModeId, availableModes };
}

/** 拍平 configOptions 分组结构（兼容 group 嵌套） */
function flattenConfigOptions(rawOptions: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  if (!rawOptions) return [];
  const flat: Array<Record<string, unknown>> = [];
  for (const opt of rawOptions) {
    if ("group" in opt && Array.isArray(opt.options)) {
      flat.push(...(opt.options as Array<Record<string, unknown>>));
    } else {
      flat.push(opt);
    }
  }
  return flat;
}

// ── Manager ──

const KEEPALIVE_INTERVAL = 30_000;

/** setup 期间的 pending 消息缓冲（防时序竞争） */
const pendingBuffers = new Map<string, string[]>();

interface YjsFrontendEntry {
  ws: WsConnection;
  userId: string;
  agentId: string;
  relayHandle: EngineRelayHandle;
  relayUnsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval>;
  instanceId: string;
  /** RCS 会话标识符 (rcs_xxx)，连接生命周期内不变 */
  rcsSessionId: string;
  /** 当前活跃的 ACP 会话标识符 (ses_xxx)，session/new、session/load 后更新；初始为 null */
  acpSessionId: string | null;
  workspacePath: string | null;
  openTime: number;
  pendingMessages: unknown[];
  relayReady: boolean;
  /** agent 是否已发送过 status（确认 ACP 初始化完成） */
  agentStatusReceived: boolean;
}

const clients = new Map<string, YjsFrontendEntry>();

// P1-7: WS 发送缓冲区背压阈值 (64KB)，防止慢客户端导致内存泄漏
const WS_SEND_THRESHOLD = 64 * 1024;

export function sendToYjsWs(ws: WsConnection, data: unknown): void {
  if (ws.readyState !== 1) return;
  // P1-7: 检查发送缓冲区积压，超阈值跳过（客户端通过重连+全量 snapshot 恢复）
  // biome-ignore lint/suspicious/noExplicitAny: bufferedAmount 不在 WsConnection 接口中，但 Bun WS 原生支持
  if (((ws as any).bufferedAmount ?? 0) > WS_SEND_THRESHOLD) return;
  ws.send(JSON.stringify(data));
}

// ── YJS 广播（直接绑定 Y.Doc 的 update 事件）──

/** 已注册广播的 Y.Doc 名称集合（防重复注册） */
const registeredDocNames = new Set<string>();

/** 清理已注册的 Y.Doc 名称（在 session doc 销毁/重建前调用，确保新 doc 能重新注册广播） */
export function unregisterYjsDocListener(docName: string): void {
  registeredDocNames.delete(docName);
}

/** 给 Y.Doc 绑定 update 监听，变更时广播给匹配 rcsSessionId 的前端 WS 客户端 */
export function registerYjsDocListener(ydoc: import("yjs").Doc, docName: string): void {
  if (registeredDocNames.has(docName)) return;
  registeredDocNames.add(docName);
  ydoc.on("update", (update: Uint8Array) => {
    const base64 = Buffer.from(update).toString("base64");
    const msg = { type: "yjs:update", docName, data: base64 };
    // 从 docName 提取 rcsSessionId 用于广播过滤
    let targetRcsSessionId: string | null = null;
    if (docName.startsWith("chat:")) {
      targetRcsSessionId = docName.slice(5);
    } else if (docName.startsWith("session:")) {
      targetRcsSessionId = docName.slice(8);
    }
    let matched = 0;
    let skipped = 0;
    for (const [, entry] of clients.entries()) {
      if (targetRcsSessionId && entry.rcsSessionId !== targetRcsSessionId) {
        skipped++;
        continue;
      }
      matched++;
      try {
        sendToYjsWs(entry.ws, msg);
      } catch {
        // 单连接失败不阻塞
      }
    }
    // 🔍 DEBUG: 广播日志
    console.debug(
      `[YJS-BROADCAST] docName=${docName} targetRcs=${targetRcsSessionId} size=${update.length} matched=${matched} skipped=${skipped} totalClients=${clients.size}`,
    );
  });
}

// ── Instance 级别 relay handle 共享 ──

type SharedRelayState = {
  handle: EngineRelayHandle;
  unsub: (() => void) | null;
  refCount: number;
  userId: string;
  agentId: string;
  instanceId: string;
  /** RCS 会话标识符，同一实例的所有前端连接共享 */
  rcsSessionId: string;
  /** 服务端根据 environment 解析的工作目录，供 ACP session RPC 使用 */
  workspacePath: string;
};

const sharedRelays = new Map<string, SharedRelayState>();

/** 遍历 clients 中匹配 agentId+instanceId 的 entry，返回第一个 acpSessionId（fallback 用） */
function findActiveSessionId(agentId: string, instanceId: string): string | undefined {
  for (const [, entry] of clients.entries()) {
    if (entry.agentId === agentId && entry.instanceId === instanceId) {
      return entry.acpSessionId ?? undefined;
    }
  }
  return undefined;
}

/** 对所有匹配 agentId+instanceId 的 entry 执行回调 */
function forEachMatchingEntry(agentId: string, instanceId: string, fn: (entry: YjsFrontendEntry) => void): void {
  for (const [, entry] of clients.entries()) {
    if (entry.agentId === agentId && entry.instanceId === instanceId) {
      fn(entry);
    }
  }
}

/** 向所有匹配 agentId+instanceId 的客户端发送消息 */
function sendToMatchingClients(agentId: string, instanceId: string, data: unknown): void {
  for (const [, entry] of clients.entries()) {
    if (entry.agentId === agentId && entry.instanceId === instanceId) {
      sendToYjsWs(entry.ws, data);
    }
  }
}

/**
 * 创建共享的 onMessage 回调。
 * processACP 每个事件只调用一次；其他状态操作（availableCommands、tokenUsage、session 同步等）
 * 也从 SharedRelayState 取值且只调用一次。
 */
function createSharedMessageHandler(shared: SharedRelayState): (message: { type: string; payload?: unknown }) => void {
  return async (message) => {
    const raw = message as unknown as Record<string, unknown>;
    const msgType = raw.type as string | undefined;
    log(`[YJS-FE] ← agent: type=${msgType ?? "(no type)"} hasPayload=${raw.payload != null}`);

    // ── sessionId 过滤：防止 in-flight 事件泄漏到错误 session ──
    const rpcCheck = extractJsonRpc(raw);
    if (rpcCheck?.method === "session/update") {
      const msgSessionId = (rpcCheck.params as Record<string, unknown> | undefined)?.sessionId as string | undefined;
      if (msgSessionId) {
        const anyMatch = Array.from(clients.values()).some(
          (e) => e.agentId === shared.agentId && e.instanceId === shared.instanceId && e.acpSessionId === msgSessionId,
        );
        if (!anyMatch) {
          log(`[YJS-FE] ignoring stale event for session ${msgSessionId} (no active client matching)`);
          return;
        }
      }
    }

    // ── relay_closed：agent 连接断开 → 关闭所有前向 WS + 清理状态 ──
    if (msgType === "relay_closed") {
      log(`[YJS-FE] agent relay closed for instanceId=${shared.instanceId}, cleaning up all frontend connections`);
      // 断开状态写入 Chat Doc
      setChatConnectionStatus(shared.rcsSessionId, {
        status: "disconnected",
        since: Date.now(),
      });
      // 关闭所有匹配的前端 WS 连接
      const entries: YjsFrontendEntry[] = [];
      forEachMatchingEntry(shared.agentId, shared.instanceId, (e) => {
        entries.push(e);
      });
      for (const e of entries) {
        try {
          sendToYjsWs(e.ws, { type: "error", payload: { message: "Agent connection lost" } });
        } catch {
          /* ignore */
        }
        try {
          e.ws.close(1011, "relay handle closed");
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // ── error / session_error：agent 级错误 → 转发前端 + 清理状态 ──
    if (msgType === "error") {
      logError(`[YJS-FE] agent error for instanceId=${shared.instanceId}:`, raw.payload);
      setChatConnectionStatus(shared.rcsSessionId, {
        status: "disconnected",
        since: Date.now(),
      });
      // 转发错误到所有匹配前端
      sendToMatchingClients(shared.agentId, shared.instanceId, raw);
      return;
    }

    if (msgType === "session_error") {
      logError(`[YJS-FE] session error for instanceId=${shared.instanceId}:`, raw.error ?? raw);
      // session_error 由 processACP 处理（设置 meta.status=error, 清除 loading）
      // 同时转发到前端
      sendToMatchingClients(shared.agentId, shared.instanceId, raw);
    }

    // ── processACP：只调用一次 ──
    // 直接使用 shared.rcsSessionId 定位 session doc
    try {
      processACP(shared.rcsSessionId, extractAcpEvent(raw, msgType));
    } catch {
      // 聚合失败不阻塞
    }

    // ── available_commands_update → 写入 Chat Doc ──
    const sessionRpc = extractJsonRpc(raw);
    if (sessionRpc?.method === "session/update" && (sessionRpc.params as Record<string, unknown> | undefined)?.update) {
      const update = (sessionRpc.params as Record<string, unknown>).update as Record<string, unknown>;
      if (update.sessionUpdate === "available_commands_update") {
        const cmds = update.availableCommands as Array<{ name: string; description?: string }> | undefined;
        if (cmds && cmds.length > 0) {
          setChatAvailableCommands(shared.rcsSessionId, cmds);
          log(`[YJS-FE] availableCommands written: ${cmds.length} commands`);
        }
      }
    }

    // ── prompt_complete → 提取 token usage 写入 Chat Doc ──
    let pcUsage: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null = null;
    if (sessionRpc && "result" in sessionRpc) {
      const resultUsage = (sessionRpc.result as Record<string, unknown>)?.usage as
        | { totalTokens?: number; inputTokens?: number; outputTokens?: number }
        | undefined;
      if (resultUsage) pcUsage = resultUsage;
    }
    if (!pcUsage) {
      const sdPayload = raw.payload as Record<string, unknown> | undefined;
      if (sdPayload?.type === "prompt_complete") {
        pcUsage = (sdPayload.payload as Record<string, unknown>)?.usage as typeof pcUsage;
      }
    }
    if (!pcUsage) {
      if (msgType === "prompt_complete") {
        pcUsage = (raw.payload as Record<string, unknown>)?.usage as typeof pcUsage;
      }
    }
    if (pcUsage) {
      setChatTokenUsage(shared.rcsSessionId, pcUsage);
      log(
        `[YJS-FE] tokenUsage written: total=${pcUsage.totalTokens ?? 0} input=${pcUsage.inputTokens ?? 0} output=${pcUsage.outputTokens ?? 0}`,
      );
    }

    // ── agent status → 标记就绪 + 自动发送 list_sessions ──
    if (msgType === "status") {
      // 提取 capabilities 写入 Chat Doc
      const capsPayload = raw.payload as Record<string, unknown> | undefined;
      const caps = capsPayload?.capabilities as Record<string, unknown> | undefined;
      if (caps) {
        setChatCapabilities(shared.rcsSessionId, caps);
        log(`[YJS-FE] capabilities written to chat doc`);
      }

      // 提取 agentInfo 写入 Chat Doc（含 model 信息）
      const agentInfoData = capsPayload?.agentInfo as Record<string, unknown> | undefined;
      if (agentInfoData) {
        const modelInfo = agentInfoData.model as { id?: string; name?: string } | undefined;
        setChatAgentInfo(shared.rcsSessionId, {
          id: shared.agentId,
          name: (agentInfoData.name as string) || shared.agentId,
          model: modelInfo ? { id: modelInfo.id || "", name: modelInfo.name || "" } : undefined,
        });
        log(`[YJS-FE] agentInfo updated from status: model=${modelInfo?.name ?? "(none)"}`);
      }

      // 标记所有匹配 entry 的 agentStatusReceived
      const needsListSessions = !Array.from(clients.values()).some(
        (e) => e.agentId === shared.agentId && e.instanceId === shared.instanceId && e.agentStatusReceived,
      );
      forEachMatchingEntry(shared.agentId, shared.instanceId, (e) => {
        e.agentStatusReceived = true;
      });

      if (needsListSessions) {
        log(`[YJS-FE] agent status received, triggering list_sessions`);
        try {
          const listRpc = translateSimpleAction({ action: "list_sessions" }, shared.workspacePath);
          shared.handle.send(listRpc as unknown as { type: string; payload?: unknown });
          log(`[YJS-FE] → agent: auto list_sessions (agent ready)`);
        } catch (err) {
          logError("[YJS-FE] auto list_sessions send failed:", err);
        }
      }
      return;
    }

    // ── 同步会话列表到 Chat Doc ──
    try {
      // ── 路径 1：非 JSON-RPC 的 session_list 消息 ──
      let listPayload: Record<string, unknown> | null = null;
      if (msgType === "session_list") {
        listPayload = raw.payload as Record<string, unknown> | null;
      } else if (msgType === "session_data") {
        const inner = raw.payload as Record<string, unknown> | undefined;
        if (inner?.type === "session_list") {
          listPayload = inner.payload as Record<string, unknown> | null;
        }
      }

      if (listPayload) {
        const sessions = listPayload.sessions as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(sessions)) {
          // 🔍 DEBUG: session_list 原始数据
          const sessionIds = sessions.map((s) => s.sessionId as string).filter(Boolean);
          console.debug(
            `[YJS-FE] session_list → rcsSessionId=${shared.rcsSessionId} count=${sessions.length} ids=[${sessionIds.join(", ")}]`,
          );
          for (const s of sessions) {
            const sid = s.sessionId as string | undefined;
            if (!sid) continue;
            const ts = s.updatedAt ? new Date(s.updatedAt as string).getTime() : 0;
            registerSession(shared.rcsSessionId, {
              sessionId: sid,
              title: (s.title as string) || "",
              preview: "",
              status: "active",
              lastMsgTs: ts > 0 ? ts : Date.now(),
              updatedAt: (s.updatedAt as string) || new Date().toISOString(),
            });
          }
          return;
        }
      }

      // ── 路径 2：JSON-RPC 格式 ──
      const rpc = extractJsonRpc(raw);
      if (!rpc || !("result" in rpc)) return;
      const result = rpc.result as Record<string, unknown> | undefined;
      if (!result || typeof result !== "object") return;

      // session/new 或 session/load 响应
      const newSessionId = result.sessionId;
      if (typeof newSessionId === "string" && newSessionId.length > 0) {
        log(`[YJS-FE] session sync: new/load sessionId=${newSessionId} (ACP)`);

        const rawConfigOpts = result.configOptions as Array<Record<string, unknown>> | undefined;
        const resultModels = (result.models ?? extractModelStateFromConfigOptions(rawConfigOpts)) as
          | { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> }
          | null
          | undefined;
        const resultModes = (result.modes ?? extractModeStateFromConfigOptions(rawConfigOpts)) as
          | {
              currentModeId: string;
              availableModes: Array<{ id: string; name: string; description?: string | null }>;
            }
          | null
          | undefined;
        if (resultModels) {
          setChatModelState(shared.rcsSessionId, resultModels);
          log(
            `[YJS-FE] modelState written: currentModelId=${resultModels.currentModelId}, availableModels=${resultModels.availableModels.length}`,
          );
        }
        if (resultModes) {
          setChatModeState(shared.rcsSessionId, resultModes);
          log(
            `[YJS-FE] modeState written: currentModeId=${resultModes.currentModeId}, availableModes=${resultModes.availableModes.length}`,
          );
        }

        // 用 RCS session ID 打开 Session Doc (C2 fix)
        const sessionDoc = await openSession(shared.userId, shared.agentId, shared.rcsSessionId);
        // 注册广播（已注册则跳过），按 rcsSessionId 命名
        registerYjsDocListener(sessionDoc.ydoc, `session:${shared.rcsSessionId}`);

        // 判断是新会话还是加载已有会话
        // new: 当前活跃的 acpSessionId 还是旧值（与 newSessionId 不同）
        // load: handleYjsWsMessage 已预更新 entry.acpSessionId 为目标 ID（相同）
        const currentActiveSessionId = findActiveSessionId(shared.agentId, shared.instanceId);
        const isNewSession = currentActiveSessionId !== newSessionId;

        // 更新所有匹配 entry 的 acpSessionId
        forEachMatchingEntry(shared.agentId, shared.instanceId, (e) => {
          e.acpSessionId = newSessionId;
        });

        if (isNewSession) {
          const now = Date.now();
          registerSession(shared.rcsSessionId, {
            sessionId: newSessionId,
            title: "",
            preview: "",
            status: "active",
            lastMsgTs: now,
            updatedAt: new Date(now).toISOString(),
          });
        }

        // 设置 activeSessionId
        setChatActiveSession(shared.rcsSessionId, newSessionId);

        // 标记新建 session 为就绪状态 (C3 fix)
        const meta = sessionDoc.ydoc.getMap("meta");
        if (meta.get("status") === "idle") {
          processACP(shared.rcsSessionId, { type: "session_update", payload: { sessionUpdate: "ready" } });
        }

        // 推送 Session Doc 完整状态到所有匹配客户端
        try {
          const sessionSnapshot = Y.encodeStateAsUpdate(sessionDoc.ydoc);
          const sessionBase64 = Buffer.from(sessionSnapshot).toString("base64");
          sendToMatchingClients(shared.agentId, shared.instanceId, {
            type: "yjs:update",
            docName: `session:${shared.rcsSessionId}`,
            data: sessionBase64,
          });
          log(
            `[YJS-FE] pushed session init state to all matched clients, acpSessionId=${newSessionId}, size=${sessionSnapshot.length}`,
          );
        } catch (e) {
          logError("[YJS-FE] Failed to push session init state:", e);
        }
        return;
      }

      // session/list 响应
      const sessions = result.sessions as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(sessions)) return;
      log(`[YJS-FE] session sync: list count=${sessions.length}`);
      for (const s of sessions) {
        const sid = s.sessionId as string | undefined;
        if (!sid) continue;
        const ts = s.updatedAt ? new Date(s.updatedAt as string).getTime() : 0;
        registerSession(shared.rcsSessionId, {
          sessionId: sid,
          title: (s.title as string) || "",
          preview: "",
          status: "active",
          lastMsgTs: ts > 0 ? ts : Date.now(),
          updatedAt: (s.updatedAt as string) || new Date().toISOString(),
        });
      }
    } catch (err) {
      logError("[YJS-FE] session sync failed:", err);
    }
  };
}

// ── open ──

export async function handleYjsWsOpen(
  ws: WsConnection,
  wsId: string,
  userId: string,
  agentId: string,
  rcsSessionId: string | null,
): Promise<void> {
  log(`[YJS-FE] open start: wsId=${wsId} userId=${userId} agentId=${agentId} sessionId=${rcsSessionId}`);
  // 注册 pending buffer：setup 期间到达的消息不会丢失
  pendingBuffers.set(wsId, []);

  // 1. 查环境
  const env = await environmentRepo.getById(agentId);
  if (!env) {
    pendingBuffers.delete(wsId);
    sendToYjsWs(ws, { type: "error", payload: { message: "Environment not found" } });
    ws.close(4004, "env not found");
    return;
  }

  const orgId = env.organizationId ?? userId;
  const workspacePath = resolveWorkspacePath(orgId, userId, agentId);

  // 2. 确保实例运行
  const { ensureRunning } = await import("../../services/instance");

  let instanceId: string;
  let ensureStatus: string;
  try {
    const result = await ensureRunning(userId, agentId, "interactive");
    instanceId = result.instance.id;
    ensureStatus = result.status;
    // 🔍 DEBUG: 诊断 instance 分配
    const { getRunningInstancesByEnvironment } = await import("../../services/instance");
    const allRunning = getRunningInstancesByEnvironment(agentId);
    const allInstanceIds = allRunning.map((i) => `${i.id}(env=${agentId})`);
    console.debug(
      `[YJS-INSTANCE] agentId=${agentId} instanceId=${instanceId} status=${ensureStatus} ` +
        `runningCount=${allRunning.length} all=[${allInstanceIds.join(", ")}]`,
    );
  } catch (err) {
    pendingBuffers.delete(wsId);
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AppError && err.code === "MACHINE_OFFLINE") {
      sendToYjsWs(ws, { type: "error", payload: { code: "machine_unavailable", message } });
      ws.close(4500, "machine offline");
      return;
    }
    sendToYjsWs(ws, { type: "error", payload: { message: `Instance start failed: ${message}` } });
    ws.close(1011, "spawn failed");
    return;
  }

  if (ws.readyState !== 1) {
    pendingBuffers.delete(wsId);
    return;
  }

  const rcsSessionIdFinal = rcsSessionId ?? `rcs_${Date.now().toString(36)}`;
  let handle: EngineRelayHandle;

  // 3. 检查是否有共享 relay（Instance 级别复用）
  let shared = sharedRelays.get(instanceId);

  // 🔍 DEBUG: 连接建立时的 rcsSessionId 状态
  const preExisting = shared ? "reuse" : "create";
  console.debug(
    `[YJS-CONNECT] wsId=${wsId} agentId=${agentId} instanceId=${instanceId} ` +
      `providedRcs=${rcsSessionId ?? "null"} generatedRcs=${rcsSessionIdFinal} ` +
      `sharedRelay=${preExisting} existingRcs=${shared?.rcsSessionId ?? "N/A"} clients=${clients.size}`,
  );

  if (shared) {
    // 复用已有 relay handle
    shared.refCount++;
    handle = shared.handle;
    log(`[YJS-FE] reusing existing relay for instanceId=${instanceId}, refCount=${shared.refCount}`);
  } else {
    // 创建新 relay handle
    const { connectAgentRelay } = await import("../agent-relay");

    try {
      handle = await connectAgentRelay(instanceId, rcsSessionIdFinal);

      if (ws.readyState !== 1) {
        pendingBuffers.delete(wsId);
        try {
          handle.close(1000, "ws closed during setup");
        } catch {
          /* ignore */
        }
        return;
      }
    } catch (err) {
      pendingBuffers.delete(wsId);
      const message = err instanceof Error ? err.message : String(err);
      logError("[YJS-FE] Failed to connect agent relay:", err);
      sendToYjsWs(ws, { type: "error", payload: { message: `Relay connect failed: ${message}` } });
      ws.close(1011, "relay failed");
      return;
    }

    // 创建 SharedRelayState 并注册全局唯一的 onMessage 监听器
    shared = {
      handle,
      unsub: null,
      refCount: 1,
      userId,
      agentId,
      instanceId,
      rcsSessionId: rcsSessionIdFinal,
      workspacePath,
    };
    sharedRelays.set(instanceId, shared);

    try {
      const fullHandle = handle as unknown as {
        onMessage?: (cb: (msg: { type: string; payload?: unknown }) => void) => () => void;
      };
      if (fullHandle.onMessage) {
        shared.unsub = fullHandle.onMessage(createSharedMessageHandler(shared));
      }
    } catch (err) {
      logError("[YJS-FE] Failed to register onMessage:", err);
    }

    // one-time init：打开 Chat Doc、注册 YJS 监听、设置 agent info
    try {
      const chatDoc = await openChat(rcsSessionIdFinal);
      registerYjsDocListener(chatDoc.ydoc, `chat:${rcsSessionIdFinal}`);

      await setChatAgentInfo(rcsSessionIdFinal, {
        id: agentId,
        name: env.machineName ?? agentId,
      });
    } catch (err) {
      logError("[YJS-FE] Failed to init chat doc:", err);
    }
  }

  // 4. 创建 entry（每个 WS 连接一个 entry）
  // P1-6: 连接数上限检查（可配置，默认 200）
  const MAX_CLIENTS = parseInt(process.env.YJS_MAX_CLIENTS || "", 10) || 200;
  if (clients.size >= MAX_CLIENTS) {
    pendingBuffers.delete(wsId);
    sendToYjsWs(ws, {
      type: "error",
      payload: { code: "too_many_connections", message: `Max ${MAX_CLIENTS} connections reached` },
    });
    ws.close(1013, "too many connections");
    return;
  }

  const keepalive = setInterval(() => {
    const entry2 = clients.get(wsId);
    if (entry2?.ws.readyState !== 1) {
      clearInterval(keepalive);
      return;
    }
    sendToYjsWs(entry2.ws, { type: "keep_alive" });
  }, KEEPALIVE_INTERVAL);

  const entry: YjsFrontendEntry = {
    ws,
    userId,
    agentId,
    relayHandle: handle,
    relayUnsub: null,
    keepalive,
    instanceId,
    rcsSessionId: shared.rcsSessionId,
    acpSessionId: null,
    workspacePath,
    openTime: Date.now(),
    pendingMessages: [],
    relayReady: false,
    agentStatusReceived: false,
  };
  clients.set(wsId, entry);
  markInstanceRelayAttached(instanceId);

  // 5. per-client 初始化（使用 shared.rcsSessionId，确保新连接接收来自共享 Chat Doc 的状态）
  const effectiveRcsSessionId = shared.rcsSessionId;
  // 🔍 DEBUG: entry 注册后的 rcsSessionId 对齐检查
  console.debug(
    `[YJS-ENTRY] wsId=${wsId} agentId=${agentId} entryRcs=${entry.rcsSessionId} ` +
      `sharedRcs=${shared.rcsSessionId} effectiveRcs=${effectiveRcsSessionId} ` +
      `match=${entry.rcsSessionId === shared.rcsSessionId ? "OK" : "MISMATCH!"} totalClients=${clients.size}`,
  );
  await setChatConnectionStatus(effectiveRcsSessionId, { status: "connected", since: Date.now() });

  // 推送 Chat Doc 完整初始状态给新连接的客户端
  try {
    const chatDoc = await openChat(effectiveRcsSessionId);
    const chatSnapshot = Y.encodeStateAsUpdate(chatDoc.ydoc);
    const chatBase64 = Buffer.from(chatSnapshot).toString("base64");
    sendToYjsWs(ws, { type: "yjs:update", docName: `chat:${effectiveRcsSessionId}`, data: chatBase64 });
    log(`[YJS-FE] pushed chat init state to wsId=${wsId}, size=${chatSnapshot.length}`);
  } catch (err) {
    logError("[YJS-FE] Failed to push init state:", err);
  }

  entry.relayReady = true;
  try {
    log(`[YJS-FE] skip explicit connect: relay handle auto-sends connect on WS open`);
  } catch {
    /* 忽略 */
  }

  // flush setup 期间缓冲的前端消息
  const pending = pendingBuffers.get(wsId);
  pendingBuffers.delete(wsId);
  if (pending && pending.length > 0) {
    log(`[YJS-FE] Flushing ${pending.length} pending message(s) for wsId=${wsId}`);
    for (const msg of pending) {
      try {
        const parsed = JSON.parse(msg) as Record<string, unknown>;
        const action = parsed.action as string | undefined;
        if (action) {
          if (action === "list_sessions") {
            log(`[YJS-FE] flush skip list_sessions: agent not ready yet, will auto-send on status`);
            continue;
          }
          const rpc = translateSimpleAction(parsed, entry.workspacePath);
          log(`[YJS-FE] flush → agent: action=${action}`);
          entry.relayHandle.send(rpc as unknown as { type: string; payload?: unknown });
        }
      } catch (err) {
        logError("[YJS-FE] flush message failed:", err);
        /* 单条失败不阻塞 */
      }
    }
  }

  log(`[YJS-FE] open complete: wsId=${wsId} instanceId=${instanceId}`);
}

// ── message ──

export async function handleYjsWsMessage(ws: WsConnection, wsId: string, data: string): Promise<void> {
  const entry = clients.get(wsId);
  if (!entry) {
    // setup 期间 entry 尚未就绪 → 缓冲等待 flush
    const buffer = pendingBuffers.get(wsId);
    if (buffer) {
      buffer.push(data);
      log(`[YJS-FE] buffered msg (pending count=${buffer.length})`);
    }
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  // ping/pong
  if (parsed.type === "ping") {
    sendToYjsWs(ws, { type: "pong" });
    return;
  }
  if (parsed.type === "keep_alive") return;

  // 简单 JSON 命令 → 翻译 + 转发 agent
  const action = parsed.action as string | undefined;
  if (action) {
    // 【关键】list_sessions：agent 还未就绪时跳过，等 status 到达后自动发送
    // 这避免了 agent 未初始化时返回 JSON-RPC 错误（我的 handler 只处理 result 路径）
    if (action === "list_sessions" && !entry.agentStatusReceived) {
      log(`[YJS-FE] defer list_sessions: agent not ready yet, will auto-send on status`);
      return;
    }
    // 【关键】load_session 和 create_session 执行前先更新 entry.acpSessionId，
    // 确保后续 agent 回放的 session/update 事件能被 processACP 正确捕获
    if (action === "load_session" || action === "create_session") {
      // load_session: 前端传的是目标 ACP session ID
      // create_session: 前端不传 sessionId，agent 响应后会更新
      if (action === "load_session") {
        const rawSid = parsed.sessionId;
        log(`[YJS-FE] load_session request: sessionId=${rawSid} (type=${typeof rawSid})`);
        if (typeof rawSid !== "string" || rawSid.length === 0) {
          logError("[YJS-FE] load_session rejected: invalid sessionId", rawSid);
          sendToYjsWs(ws, {
            type: "error",
            payload: { code: "INVALID_SESSION_ID", message: "load_session requires a valid sessionId" },
          });
          return;
        }
        const targetSid = rawSid;

        // 销毁目标 Session Doc（内存 + Redis），防止 agent 回放历史时消息重复。
        // 会话 doc 按 rcsSessionId 存储，清理时使用 rcsSessionId 作为 key。
        // 如果多次 load 同一 rcsSession，先清除旧数据再重建。
        log(`[YJS-FE] clearing session doc for load: rcsSessionId=${entry.rcsSessionId} targetSid=${targetSid}`);
        await closeSession(entry.rcsSessionId);
        unregisterYjsDocListener(`session:${entry.rcsSessionId}`);
        const redis = getRedisConnection();
        if (redis) {
          await redis.del(`yjs:session:${entry.rcsSessionId}`).catch((err) => {
            logError(`[YJS-FE] Failed to clear Redis for session ${entry.rcsSessionId}:`, err);
          });
        }
        log(`[YJS-FE] pre-creating session doc for load: rcsSessionId=${entry.rcsSessionId}`);
        entry.acpSessionId = targetSid;
        try {
          const sessionDoc = await openSession(entry.userId, entry.agentId, entry.rcsSessionId);
          registerYjsDocListener(sessionDoc.ydoc, `session:${entry.rcsSessionId}`);
        } catch (err) {
          logError("[YJS-FE] Failed to pre-create session doc:", err);
        }
      }
    }

    // 【用户消息写入 Session Doc】send_prompt 时提取 content 中的 text，先写后发
    // 这样即使 agent 不回显 user_message_chunk，后端 Y.Doc 也有用户消息记录，前端通过 YJS 同步渲染
    // 使用 rcsSessionId 而非 acpSessionId：session doc 按 rcsSessionId 索引，在 session/new 响应前 acpSessionId 仍为 null
    if (action === "send_prompt" && entry.rcsSessionId) {
      const contentBlocks = parsed.content as Array<{ type: string; text?: string }> | undefined;
      const text =
        contentBlocks
          ?.filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n") || "";
      if (text) {
        // 确保 session doc 在内存中（已存在则直接返回，开销极小）
        try {
          await openSession(entry.userId, entry.agentId, entry.rcsSessionId);
        } catch (err) {
          logError("[YJS-FE] Failed to ensure session doc for user message:", err);
        }
        processACP(entry.rcsSessionId, {
          type: "user_message_chunk",
          payload: { content: { type: "text", text } },
        });
        log(`[YJS-FE] wrote user_message_chunk to rcsSessionId=${entry.rcsSessionId} (${text.length} chars)`);
      }
    }

    const rpc = translateSimpleAction(parsed, entry.workspacePath);
    log(`[YJS-FE] → agent: action=${action} acpSessionId=${entry.acpSessionId}`);
    try {
      entry.relayHandle.send(rpc as unknown as { type: string; payload?: unknown });
      log(`[YJS-FE] → agent: sent OK`);
    } catch (err) {
      logError("[YJS-FE] relay handle send error:", err);
      sendToYjsWs(ws, { type: "error", payload: { message: "Agent connection error" } });
    }

    // cancel: 主动清除 YJS Doc 的 loading 状态。
    // agent/cancel 的 JSON-RPC 响应不带 type 字段，不会触发 applyACPEvent 的任何 handler，
    // 因此 meta.loading 永远不会被清除。此处乐观更新 YJS Doc，确保前端 Stop 按钮切换回 Send。
    if (action === "cancel" && entry.acpSessionId) {
      try {
        processACP(entry.rcsSessionId, { type: "agent_message_complete", payload: {} });
        log(`[YJS-FE] cancel: cleared loading on rcsSessionId=${entry.rcsSessionId}`);
      } catch (err) {
        logError("[YJS-FE] cancel: failed to clear session loading:", err);
      }
    }

    return;
  }

  // 其他消息不处理
}

// ── close ──

export function handleYjsWsClose(wsId: string): void {
  pendingBuffers.delete(wsId);
  const entry = clients.get(wsId);
  if (!entry) return;

  clearInterval(entry.keepalive);
  clients.delete(wsId);

  // 管理共享 relay：refCount--，若归零则清理
  const shared = sharedRelays.get(entry.instanceId);
  if (shared) {
    shared.refCount--;
    if (shared.refCount <= 0) {
      shared.unsub?.();
      try {
        shared.handle.close(1000, "all yjs frontend clients disconnected");
      } catch {
        /* ignore */
      }
      sharedRelays.delete(entry.instanceId);
    }
  }

  // 仅在最后一个客户端断开时 detach
  if (entry.instanceId && !sharedRelays.has(entry.instanceId)) {
    markInstanceRelayDetached(entry.instanceId);
  }

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(`[YJS-FE] Disconnected: wsId=${wsId} agentId=${entry.agentId} duration=${duration}s`);
}
