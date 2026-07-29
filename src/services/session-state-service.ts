// src/services/session-state-service.ts

import type {
  ACPEvent,
  AgentInfo,
  ChatDoc,
  ConnectionStatus,
  PermissionRequest,
  SessionDoc,
  SessionSummary,
} from "@fenix/acp-server";
import {
  addPermission,
  addSession,
  applyACPEvent,
  createChatDoc,
  createSessionDoc,
  loadChatDoc,
  loadSessionDoc,
  resolvePermission,
  setActiveSession,
  setAgentInfo,
  setAvailableCommands,
  setCapabilities,
  setConnectionStatus,
  setModelState,
  setModeState,
  setSwitchingSession,
  setTokenUsage,
  syncSessions,
  updateSession,
} from "@fenix/acp-server";
import { log, error as logError } from "@fenix/logger";
import type * as Y from "yjs";
import { getRedisConnection } from "./cache";

// ── 全局单例（进程内）──

const chatDocs = new Map<string, ChatDoc>(); // key = rcsSessionId
const sessionDocs = new Map<string, SessionDoc>(); // key = rcsSessionId

// ── Yjs update 广播回调 ──

type YjsUpdateCallback = (docName: string, update: Uint8Array) => void;
let _onYjsUpdate: YjsUpdateCallback | null = null;

export function setYjsUpdateHandler(handler: YjsUpdateCallback | null): void {
  _onYjsUpdate = handler;
}

/** 给 Y.Doc 绑定 update 监听，驱动广播回调 */
function registerDocBroadcast(ydoc: Y.Doc, docName: string): void {
  ydoc.on("update", (update: Uint8Array) => {
    _onYjsUpdate?.(docName, update);
  });
}

// ── Chat 级别 ──

export async function openChat(rcsSessionId: string): Promise<ChatDoc> {
  const existing = chatDocs.get(rcsSessionId);
  if (existing) return existing;

  const redis = getRedisConnection();
  if (!redis) {
    // 内存模式：无 Redis 也不报错，状态不持久化但同步功能依然可用
    log("[session-state] No Redis connection, running in memory-only mode");
    const doc = createChatDoc(rcsSessionId, null);
    registerDocBroadcast(doc.ydoc, `chat:${rcsSessionId}`);
    chatDocs.set(rcsSessionId, doc);
    return doc;
  }

  const doc = loadChatDoc(rcsSessionId, redis);
  registerDocBroadcast(doc.ydoc, `chat:${rcsSessionId}`);
  chatDocs.set(rcsSessionId, doc);
  return doc;
}

export function getChat(rcsSessionId: string): ChatDoc | undefined {
  return chatDocs.get(rcsSessionId);
}

export async function closeChat(rcsSessionId: string): Promise<void> {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) {
    await doc.destroy();
    chatDocs.delete(rcsSessionId);
  }
}

// ── Chat 状态写入 ──

export function setChatConnectionStatus(rcsSessionId: string, status: ConnectionStatus): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) setConnectionStatus(doc.ydoc, status);
}

export function setChatAgentInfo(rcsSessionId: string, info: AgentInfo): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) setAgentInfo(doc.ydoc, info);
}

export function setChatCapabilities(rcsSessionId: string, caps: Record<string, unknown>): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) setCapabilities(doc.ydoc, caps);
}

export function setChatModelState(
  rcsSessionId: string,
  state: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> },
): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) setModelState(doc.ydoc, state);
}

export function setChatModeState(
  rcsSessionId: string,
  state: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string | null }> },
): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) setModeState(doc.ydoc, state);
}

export function setChatAvailableCommands(
  rcsSessionId: string,
  commands: Array<{ name: string; description?: string }>,
): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) setAvailableCommands(doc.ydoc, commands);
}

export function setChatTokenUsage(
  rcsSessionId: string,
  usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number },
): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) setTokenUsage(doc.ydoc, usage);
}

// ── Session 级别 ──

/** 注意: openSession 不再自动创建 Chat Doc。调用方必须确保 openChat(rcsSessionId) 已调用。 */
export async function openSession(_userId: string, _agentId: string, rcsSessionId: string): Promise<SessionDoc> {
  const existing = sessionDocs.get(rcsSessionId);
  if (existing) {
    // 清除缓存会话可能遗留的脏 loading 状态
    const meta = existing.ydoc.getMap("meta");
    if (meta.get("loading") !== null) {
      meta.set("loading", null);
    }
    return existing;
  }

  const redis = getRedisConnection();
  if (!redis) {
    // 内存模式
    const doc = createSessionDoc(rcsSessionId, null);
    registerDocBroadcast(doc.ydoc, `session:${rcsSessionId}`);
    sessionDocs.set(rcsSessionId, doc);
    return doc;
  }

  const doc = loadSessionDoc(rcsSessionId, redis);
  // 清除从 Redis 加载可能遗留的脏 loading 状态。
  // 用 setTimeout(0)（Bun）将清除动作推迟到下一个 macrotask，确保先行的 Redis getBuffer.then（microtask）先执行完毕。
  const scheduleClear = () => {
    doc.ydoc.getMap("meta").set("loading", null);
  };
  if (typeof setImmediate === "function") {
    setImmediate(scheduleClear);
  } else {
    setTimeout(scheduleClear, 0);
  }
  registerDocBroadcast(doc.ydoc, `session:${rcsSessionId}`);
  sessionDocs.set(rcsSessionId, doc);
  return doc;
}

export function getSession(rcsSessionId: string): SessionDoc | undefined {
  return sessionDocs.get(rcsSessionId);
}

/** 编排 session 切换（H2: 需 rcsSessionId 查找 session doc + acpSessionId 构建 session/load JSON-RPC 参数） */
export async function switchSession(
  chatDoc: ChatDoc,
  relayHandle: { send: (msg: unknown) => void },
  rcsSessionId: string,
  acpSessionId: string,
): Promise<void> {
  // 1. 确保 Session Doc 在内存
  if (!sessionDocs.has(rcsSessionId)) {
    const redis = getRedisConnection();
    const doc = redis ? loadSessionDoc(rcsSessionId, redis) : createSessionDoc(rcsSessionId, null);
    sessionDocs.set(rcsSessionId, doc);
  }

  setSwitchingSession(chatDoc.ydoc, true);

  // 2. 通知 agent 加载 session
  try {
    relayHandle.send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "session/load",
      params: { sessionId: acpSessionId },
    });
  } catch (err) {
    logError("[session-state] Failed to send session/load:", err);
  }

  // 3. 写 activeSessionId
  setActiveSession(chatDoc.ydoc, acpSessionId);
}

// ── ACP 事件微批次合并 ──

/** 合并窗口（毫秒）。session/load 回放时多条消息可落入同一窗口合并为一个 yjs:update。 */
const ACP_BATCH_WINDOW_MS = 16;

/** 可合并的事件类型：内容类事件。控制类事件（session_update/error 等）必须立即生效。 */
const BATCHABLE_EVENT_TYPES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "agent_message_complete",
  "prompt_complete",
  "user_message_chunk",
  "tool_call",
  "tool_call_result",
  "tool_call_error",
  "tool_call_update",
  "plan",
]);

const acpBatchBuffers = new Map<string, { events: ACPEvent[]; timer: ReturnType<typeof setTimeout> }>();

function flushACPBatch(rcsSessionId: string): void {
  const batch = acpBatchBuffers.get(rcsSessionId);
  if (!batch) return;
  acpBatchBuffers.delete(rcsSessionId);
  clearTimeout(batch.timer);

  const doc = sessionDocs.get(rcsSessionId);
  if (!doc || batch.events.length === 0) return;

  try {
    if (batch.events.length === 1) {
      applyACPEvent(doc.ydoc, batch.events[0]);
    } else {
      // 多个事件合并到一个 Y.Doc 事务，N 个 session/update 帧 → 1 个 yjs:update
      doc.ydoc.transact(() => {
        for (const event of batch.events) {
          applyACPEvent(doc.ydoc, event);
        }
      });
    }
  } catch (err) {
    logError(`[session-state] flushACPBatch failed for ${rcsSessionId}, ${batch.events.length} events lost`, err);
  }
}

export function processACP(rcsSessionId: string, event: ACPEvent): void {
  const doc = sessionDocs.get(rcsSessionId);
  if (!doc) {
    log(`[session-state] Session ${rcsSessionId} not in memory, skipping ACP event type=${event.type}`);
    return;
  }

  // 控制类事件直接应用，不参与批处理。但必须先刷新 pending 内容批次，保证顺序
  if (!BATCHABLE_EVENT_TYPES.has(event.type)) {
    // flush 失败不阻止控制事件 apply，避免前端 loading 状态卡住
    try {
      flushACPBatch(rcsSessionId);
    } catch (err) {
      logError(`[session-state] flushACPBatch failed before control event ${event.type}:`, err);
    }
    applyACPEvent(doc.ydoc, event);
    return;
  }

  const existing = acpBatchBuffers.get(rcsSessionId);
  if (existing) {
    existing.events.push(event);
    return;
  }

  const timer = setTimeout(() => flushACPBatch(rcsSessionId), ACP_BATCH_WINDOW_MS);
  acpBatchBuffers.set(rcsSessionId, { events: [event], timer });
}

export function cancelACPBatch(rcsSessionId: string): void {
  const batch = acpBatchBuffers.get(rcsSessionId);
  if (batch) {
    clearTimeout(batch.timer);
    acpBatchBuffers.delete(rcsSessionId);
  }
}

export async function closeSession(rcsSessionId: string): Promise<void> {
  cancelACPBatch(rcsSessionId);
  // 提前从 Map 删除阻止新事件写入正在 destroy 的 Doc
  const doc = sessionDocs.get(rcsSessionId);
  sessionDocs.delete(rcsSessionId);
  if (doc) {
    await doc.destroy();
  }
}

/**
 * 在 Y.Doc 事务内原地清空 Session Doc 的全部内容。
 * 供真实文档和持久化前的克隆快照共用，确保清空规则一致。
 */
export function clearSessionYDocContent(ydoc: Y.Doc): void {
  ydoc.transact(() => {
    const messages = ydoc.getArray("messages");
    messages.delete(0, messages.length);
    const structuredMessages = ydoc.getArray("structuredMessages");
    structuredMessages.delete(0, structuredMessages.length);
    const streaming = ydoc.getMap("streaming");
    streaming.clear();
    const tools = ydoc.getMap("tools");
    tools.clear();
    const artifacts = ydoc.getArray("artifacts");
    artifacts.delete(0, artifacts.length);
    const meta = ydoc.getMap("meta");
    meta.set("status", "idle");
    meta.set("loading", null);
  });
}

/**
 * 在 Y.Doc 事务内原地清空 Session Doc 的全部内容。
 * 用于会话切换（load/create）时重置状态，避免 destroy+recreate 的竞态。
 */
export function clearSessionDocContent(rcsSessionId: string): void {
  const doc = sessionDocs.get(rcsSessionId);
  if (!doc) return;
  clearSessionYDocContent(doc.ydoc);
}

/**
 * 检查 Session Doc 是否包含实际消息内容。
 * 判断依据：legacy messages 数组或 Phase C structuredMessages 数组任一非空。
 */
export function hasSessionDocContent(rcsSessionId: string): boolean {
  const doc = sessionDocs.get(rcsSessionId);
  if (!doc) return false;
  const messages = doc.ydoc.getArray("messages");
  if (messages.length > 0) return true;
  const structuredMessages = doc.ydoc.getArray("structuredMessages");
  return structuredMessages.length > 0;
}

// ── 用户操作 ──

export function registerUserMessage(rcsSessionId: string, content: string): void {
  processACP(rcsSessionId, { type: "user_message_chunk", payload: { content: { type: "text", text: content } } });
}

export function handlePermissionRequest(rcsSessionId: string, perm: PermissionRequest): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) addPermission(doc.ydoc, perm);
}

export function handlePermissionResolution(
  rcsSessionId: string,
  permId: string,
  decision: "approved" | "denied",
): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) resolvePermission(doc.ydoc, permId, decision);
}

// ── Session summary ──

export function registerSession(rcsSessionId: string, summary: SessionSummary): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) {
    addSession(doc.ydoc, summary);
  }
}

/** 全量同步 session 列表到 Chat Doc（增/改/删）。供 session/list 轮询使用。 */
export function syncChatSessions(rcsSessionId: string, sessions: SessionSummary[]): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) {
    syncSessions(doc.ydoc, sessions);
  }
}

/** 设置当前激活的 session（写 activeSessionId 到 Chat Doc） */
export function setChatActiveSession(rcsSessionId: string, acpSessionId: string): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) setActiveSession(doc.ydoc, acpSessionId);
}

export function updateSessionSummary(rcsSessionId: string, acpSessionId: string, patch: Partial<SessionSummary>): void {
  const doc = chatDocs.get(rcsSessionId);
  if (doc) updateSession(doc.ydoc, acpSessionId, patch);
}

export function getChatYdoc(rcsSessionId: string): Y.Doc | undefined {
  return chatDocs.get(rcsSessionId)?.ydoc;
}

export function getSessionYdoc(rcsSessionId: string): Y.Doc | undefined {
  return sessionDocs.get(rcsSessionId)?.ydoc;
}

// ── 清理 ──

export async function closeAll(): Promise<void> {
  // 快照 keys，避免迭代期间 cancelACPBatch 修改 Map
  const batchKeys = [...acpBatchBuffers.keys()];
  for (const rcsSessionId of batchKeys) {
    cancelACPBatch(rcsSessionId);
  }

  for (const doc of sessionDocs.values()) {
    await doc.destroy();
  }
  sessionDocs.clear();

  for (const doc of chatDocs.values()) {
    await doc.destroy();
  }
  chatDocs.clear();
}
