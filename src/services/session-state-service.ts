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
export async function openSession(userId: string, agentId: string, rcsSessionId: string): Promise<SessionDoc> {
  const existing = sessionDocs.get(rcsSessionId);
  if (existing) {
    // 清除缓存会话可能遗留的脏 loading 状态。
    const meta = existing.ydoc.getMap("meta");
    if (meta.get("loading") !== null) {
      console.log(`[SessionState] openSession(hit): clearing stale loading for ${rcsSessionId}`);
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
  // 注意：loadSessionDoc 内部通过 RedisProvider 异步加载 Redis 数据（getBuffer → Y.applyUpdate），
  // 若在此时同步清除 loading，Redis 异步回调可能在之后执行并用旧状态覆盖掉 null 值。
  // 因此用 setImmediate（Node）/ setTimeout(0)（Bun）将清除动作推迟到下一个 macrotask，
  // 确保先行的 Redis getBuffer.then（microtask）先执行完毕。
  const scheduleClear = () => {
    doc.ydoc.getMap("meta").set("loading", null);
    console.log(`[SessionState] openSession(new): deferred clear loading for ${rcsSessionId}`);
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

export function processACP(rcsSessionId: string, event: ACPEvent): void {
  const doc = sessionDocs.get(rcsSessionId);
  if (!doc) {
    log(`[session-state] Session ${rcsSessionId} not in memory, skipping ACP event`);
    return;
  }
  applyACPEvent(doc.ydoc, event);
}

export async function closeSession(rcsSessionId: string): Promise<void> {
  const doc = sessionDocs.get(rcsSessionId);
  if (doc) {
    await doc.destroy();
    sessionDocs.delete(rcsSessionId);
  }
}

// ── 用户操作 ──

export function registerUserMessage(rcsSessionId: string, content: string): void {
  processACP(rcsSessionId, { type: "user_message", payload: { text: content } });
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
    // 🔍 DEBUG: 打印写入的 session 数据
    console.debug(
      `[YJS-WRITE] registerSession rcsSessionId=${rcsSessionId} sessionId=${summary.sessionId} title="${summary.title}" status=${summary.status}`,
    );
    addSession(doc.ydoc, summary);
  } else {
    console.debug(
      `[YJS-WRITE] registerSession rcsSessionId=${rcsSessionId} sessionId=${summary.sessionId} SKIP (no ChatDoc)`,
    );
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
  for (const doc of sessionDocs.values()) {
    await doc.destroy();
  }
  sessionDocs.clear();

  for (const doc of chatDocs.values()) {
    await doc.destroy();
  }
  chatDocs.clear();
}
