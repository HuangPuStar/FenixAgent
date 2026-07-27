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
  updateSession,
} from "@fenix/acp-server";
import { log, error as logError } from "@fenix/logger";
import type { Redis } from "ioredis";
import type * as Y from "yjs";
import { getRedisConnection } from "./cache";

// ── 全局单例（进程内）──

const chatDocs = new Map<string, ChatDoc>(); // key = "userId:agentId"
const sessionDocs = new Map<string, SessionDoc>(); // key = acpSessionId

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

export async function openChat(userId: string, agentId: string): Promise<ChatDoc> {
  const key = `${userId}:${agentId}`;
  const existing = chatDocs.get(key);
  if (existing) return existing;

  const redis = getRedisConnection();
  if (!redis) {
    // 内存模式：无 Redis 也不报错，状态不持久化但同步功能依然可用
    log("[session-state] No Redis connection, running in memory-only mode");
    const doc = createChatDoc(userId, agentId, null);
    registerDocBroadcast(doc.ydoc, `chat:${userId}:${agentId}`);
    chatDocs.set(key, doc);
    return doc;
  }

  const doc = loadChatDoc(userId, agentId, redis);
  registerDocBroadcast(doc.ydoc, `chat:${userId}:${agentId}`);
  chatDocs.set(key, doc);
  return doc;
}

export function getChat(userId: string, agentId: string): ChatDoc | undefined {
  return chatDocs.get(`${userId}:${agentId}`);
}

export async function closeChat(userId: string, agentId: string): Promise<void> {
  const key = `${userId}:${agentId}`;
  const doc = chatDocs.get(key);
  if (doc) {
    await doc.destroy();
    chatDocs.delete(key);
  }
}

// ── Chat 状态写入 ──

export function setChatConnectionStatus(userId: string, agentId: string, status: ConnectionStatus): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) setConnectionStatus(doc.ydoc, status);
}

export function setChatAgentInfo(userId: string, agentId: string, info: AgentInfo): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) setAgentInfo(doc.ydoc, info);
}

export function setChatCapabilities(userId: string, agentId: string, caps: Record<string, unknown>): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) setCapabilities(doc.ydoc, caps);
}

export function setChatModelState(
  userId: string,
  agentId: string,
  state: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> },
): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) setModelState(doc.ydoc, state);
}

export function setChatModeState(
  userId: string,
  agentId: string,
  state: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string | null }> },
): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) setModeState(doc.ydoc, state);
}

export function setChatAvailableCommands(
  userId: string,
  agentId: string,
  commands: Array<{ name: string; description?: string }>,
): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) setAvailableCommands(doc.ydoc, commands);
}

export function setChatTokenUsage(
  userId: string,
  agentId: string,
  usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number },
): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) setTokenUsage(doc.ydoc, usage);
}

// ── Session 级别 ──

export async function openSession(userId: string, agentId: string, acpSessionId: string): Promise<SessionDoc> {
  const existing = sessionDocs.get(acpSessionId);
  if (existing) {
    // 清除缓存会话可能遗留的脏 loading 状态。
    const meta = existing.ydoc.getMap("meta");
    if (meta.get("loading") !== null) {
      console.log(`[SessionState] openSession(hit): clearing stale loading for ${acpSessionId}`);
      meta.set("loading", null);
    }
    return existing;
  }

  await openChat(userId, agentId);

  const redis = getRedisConnection();
  if (!redis) {
    // 内存模式
    const doc = createSessionDoc(acpSessionId, null);
    registerDocBroadcast(doc.ydoc, `session:${acpSessionId}`);
    sessionDocs.set(acpSessionId, doc);
    return doc;
  }

  const doc = loadSessionDoc(acpSessionId, redis);
  // 清除从 Redis 加载可能遗留的脏 loading 状态。
  // 注意：loadSessionDoc 内部通过 RedisProvider 异步加载 Redis 数据（getBuffer → Y.applyUpdate），
  // 若在此时同步清除 loading，Redis 异步回调可能在之后执行并用旧状态覆盖掉 null 值。
  // 因此用 setImmediate（Node）/ setTimeout(0)（Bun）将清除动作推迟到下一个 macrotask，
  // 确保先行的 Redis getBuffer.then（microtask）先执行完毕。
  const scheduleClear = () => {
    doc.ydoc.getMap("meta").set("loading", null);
    console.log(`[SessionState] openSession(new): deferred clear loading for ${acpSessionId}`);
  };
  if (typeof setImmediate === "function") {
    setImmediate(scheduleClear);
  } else {
    setTimeout(scheduleClear, 0);
  }
  registerDocBroadcast(doc.ydoc, `session:${acpSessionId}`);
  sessionDocs.set(acpSessionId, doc);
  return doc;
}

export function getSession(acpSessionId: string): SessionDoc | undefined {
  return sessionDocs.get(acpSessionId);
}

/** 编排 session 切换 */
export async function switchSession(
  chatDoc: ChatDoc,
  relayHandle: { send: (msg: unknown) => void },
  acpSessionId: string,
): Promise<void> {
  // 1. 确保 Session Doc 在内存
  if (!sessionDocs.has(acpSessionId)) {
    const redis = getRedisConnection();
    const doc = redis ? loadSessionDoc(acpSessionId, redis) : createSessionDoc(acpSessionId, null);
    sessionDocs.set(acpSessionId, doc);
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

export function processACP(acpSessionId: string, event: ACPEvent): void {
  const doc = sessionDocs.get(acpSessionId);
  if (!doc) {
    log(`[session-state] Session ${acpSessionId} not in memory, skipping ACP event`);
    return;
  }
  applyACPEvent(doc.ydoc, event);
}

export async function closeSession(acpSessionId: string): Promise<void> {
  const doc = sessionDocs.get(acpSessionId);
  if (doc) {
    await doc.destroy();
    sessionDocs.delete(acpSessionId);
  }
}

// ── 用户操作 ──

export function registerUserMessage(acpSessionId: string, content: string): void {
  processACP(acpSessionId, { type: "user_message", payload: { text: content } });
}

export function handlePermissionRequest(userId: string, agentId: string, perm: PermissionRequest): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) addPermission(doc.ydoc, perm);
}

export function handlePermissionResolution(
  userId: string,
  agentId: string,
  permId: string,
  decision: "approved" | "denied",
): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) resolvePermission(doc.ydoc, permId, decision);
}

// ── Session summary ──

export function registerSession(userId: string, agentId: string, summary: SessionSummary): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) addSession(doc.ydoc, summary);
}

/** 设置当前激活的 session（写 activeSessionId 到 Chat Doc） */
export function setChatActiveSession(userId: string, agentId: string, acpSessionId: string): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) setActiveSession(doc.ydoc, acpSessionId);
}

export function updateSessionSummary(
  userId: string,
  agentId: string,
  acpSessionId: string,
  patch: Partial<SessionSummary>,
): void {
  const doc = chatDocs.get(`${userId}:${agentId}`);
  if (doc) updateSession(doc.ydoc, acpSessionId, patch);
}

export function getChatYdoc(userId: string, agentId: string): Y.Doc | undefined {
  return chatDocs.get(`${userId}:${agentId}`)?.ydoc;
}

export function getSessionYdoc(acpSessionId: string): Y.Doc | undefined {
  return sessionDocs.get(acpSessionId)?.ydoc;
}

// ── 清理 ──

export async function closeAll(): Promise<void> {
  for (const doc of sessionDocs.values()) {
    await doc.destroy();
  }
  sessionDocs.clear();

  for (const doc of chatDocs.values()) {
    await doc.destroy();
  }
  chatDocs.clear();
}
