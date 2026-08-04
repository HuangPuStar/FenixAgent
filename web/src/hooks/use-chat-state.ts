// web/src/hooks/use-chat-state.ts
// 订阅两份 Y.Doc 派生 ChatStateSnapshot（展示形状保持，数据来源切到新 schema）：
// - Chat Doc（chat:{rcsSessionId}）：token 用量（turn 完成时写入 assistant entry）
// - Session Doc（session:{rcsSessionId}）：session/agent/pendingPermissions
//
// 旧字段（agentInfo/sessions/chatMeta/connection/modelState/modeState/availableCommands）
// 已从 Y.Doc schema 删除；此处按新结构派生，无法派生的字段给保守默认值
// （模型/模式/命令选择属协议配置，C3+ 阶段由控制面另行提供）。

import type { AgentInfo, ChatStateSnapshot, SessionSummary } from "@fenix/chat-channel";
import { createYjsStore, stableKey, type YjsStore } from "@fenix/chat-channel";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as Y from "yjs";

// ── Chat Doc 派生：token 用量（turn 终态写入 assistant entry 的 tokenUsage）──

interface ChatTokenSnapshot {
  tokenUsage: ChatStateSnapshot["tokenUsage"];
}

function computeTokenSnapshot(ydoc: Y.Doc): ChatTokenSnapshot {
  const root = ydoc.getMap("root");
  const order = (root.get("entryOrder") as Y.Array<string> | undefined) ?? new Y.Array<string>();
  const entries = (root.get("entries") as Y.Map<Y.Map<unknown>> | undefined) ?? new Y.Map<Y.Map<unknown>>();

  // 取最后一个携带 tokenUsage 的 assistant entry（prompt_complete 写入）
  let tokenUsage: ChatTokenSnapshot["tokenUsage"] = null;
  for (const entryId of order.toArray()) {
    const entry = entries.get(entryId);
    if (!entry) continue;
    if (entry.get("kind") !== "message" || entry.get("role") !== "assistant") continue;
    const usage = entry.get("tokenUsage") as
      | { totalTokens?: number; inputTokens?: number; outputTokens?: number }
      | undefined;
    if (usage && typeof usage === "object") tokenUsage = usage;
  }
  return { tokenUsage };
}

// ── Session Doc 派生：会话元信息 + Agent 状态 + 权限 ──

interface ChatMetaSnapshot {
  sessionId: string;
  title: string | null;
  status: string;
  instanceId: string | null;
  acpSessionId: string | null;
  capabilities: Record<string, boolean> | null;
  permissions: ChatStateSnapshot["permissions"];
}

function computeMetaSnapshot(ydoc: Y.Doc): ChatMetaSnapshot {
  const root = ydoc.getMap("root");
  const session = (root.get("session") as Y.Map<unknown> | undefined) ?? new Y.Map<unknown>();
  const agent = (root.get("agent") as Y.Map<unknown> | undefined) ?? new Y.Map<unknown>();
  const pending = (root.get("pendingPermissions") as Y.Map<Y.Map<unknown>> | undefined) ?? new Y.Map<Y.Map<unknown>>();

  const capsMap = agent.get("capabilities");
  const capabilities: Record<string, boolean> | null =
    capsMap instanceof Y.Map && capsMap.size > 0 ? Object.fromEntries(capsMap.entries()) : null;

  const permissions: ChatStateSnapshot["permissions"] = [];
  for (const [permissionId, permission] of pending.entries()) {
    // Session Doc 三态（pending/resolved/expired）→ 前端展示态：
    // 只有 pending 可操作；resolved/expired 均视为已处理（"只能解决一次"前端体现），
    // 后端 CAS 兜底保证重复响应不生效
    const rawStatus = permission.get("status");
    const displayStatus: "pending" | "approved" | "denied" =
      rawStatus === "pending" ? "pending" : rawStatus === "resolved" ? "approved" : "denied";
    permissions.push({
      id: permissionId,
      tool: (permission.get("title") as string) || "",
      args: (permission.get("description") as Record<string, unknown> | undefined) ?? undefined,
      level: "ask",
      status: displayStatus,
      ts: permission.get("expiresAt") ? new Date(permission.get("expiresAt") as string).getTime() : 0,
    });
  }

  return {
    sessionId: (session.get("sessionId") as string | undefined) ?? "",
    title: (session.get("title") as string | null | undefined) ?? null,
    status: (session.get("status") as string | undefined) ?? "initializing",
    instanceId: (agent.get("instanceId") as string | null | undefined) ?? null,
    acpSessionId: (agent.get("acpSessionId") as string | null | undefined) ?? null,
    capabilities,
    permissions,
  };
}

// ── 合并快照 ──

function computeChatSnapshot(token: ChatTokenSnapshot, meta: ChatMetaSnapshot): ChatStateSnapshot {
  const agentInfo: AgentInfo = {
    id: meta.instanceId ?? meta.acpSessionId ?? "",
    name: "",
  };
  const sessions: SessionSummary[] = meta.sessionId
    ? [
        {
          sessionId: meta.sessionId,
          title: meta.title ?? "",
          preview: "",
          status: meta.status === "ready" ? "active" : "idle",
          lastMsgTs: 0,
          updatedAt: undefined,
        },
      ]
    : [];

  return {
    agentInfo,
    sessions,
    activeSessionId: meta.sessionId,
    connection: { status: "disconnected", since: 0 },
    permissions: meta.permissions,
    isSwitchingSession: false,
    capabilities: meta.capabilities,
    // 以下字段已从 Y.Doc schema 删除（模型/模式/命令选择），保守默认值：
    modelState: null,
    modeState: null,
    availableCommands: [],
    tokenUsage: token.tokenUsage,
  };
}

/**
 * 订阅 chat 级别状态（时间线 token + 会话元信息）。
 * 内部双 store（Chat Doc / Session Doc），applyUpdate(docName, data) 按前缀路由。
 */
export function useChatState(rcsSessionId: string) {
  const storeRef = useRef<{
    chat: YjsStore<ChatTokenSnapshot>;
    meta: YjsStore<ChatMetaSnapshot>;
  } | null>(null);
  if (!storeRef.current) {
    storeRef.current = {
      chat: createYjsStore<ChatTokenSnapshot>(computeTokenSnapshot, { tokenUsage: null }, (s) => stableKey(s)),
      meta: createYjsStore<ChatMetaSnapshot>(
        computeMetaSnapshot,
        {
          sessionId: "",
          title: null,
          status: "initializing",
          instanceId: null,
          acpSessionId: null,
          capabilities: null,
          permissions: [],
        },
        (s) => stableKey(s),
      ),
    };
  }
  const stores = storeRef.current;

  const prevKeyRef = useRef<string | null>(null);
  if (prevKeyRef.current !== rcsSessionId) {
    prevKeyRef.current = rcsSessionId;
    for (const store of [stores.chat, stores.meta]) {
      store.switchDoc(rcsSessionId, () => {
        const ydoc = new Y.Doc();
        return { ydoc };
      });
    }
  }

  const token = useSyncExternalStore(stores.chat.subscribe, stores.chat.getSnapshot);
  const meta = useSyncExternalStore(stores.meta.subscribe, stores.meta.getSnapshot);
  const state = useMemo(() => computeChatSnapshot(token, meta), [token, meta]);

  useEffect(() => {
    return () => {
      stores.chat.destroy();
      stores.meta.destroy();
    };
  }, [stores]);

  const applyUpdate = useCallback(
    (docName: string, data: Uint8Array) => {
      if (docName.startsWith("chat:")) stores.chat.applyUpdate(data);
      else stores.meta.applyUpdate(data);
    },
    [stores],
  );

  return { state, applyUpdate };
}
