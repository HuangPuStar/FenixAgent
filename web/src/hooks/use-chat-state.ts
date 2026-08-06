// web/src/hooks/use-chat-state.ts
// 订阅两份 Y.Doc 派生 ChatStateSnapshot（展示形状保持，数据来源切到新 schema）：
// - Chat Doc（chat:{rcsSessionId}）：token 用量（turn 完成时写入 assistant entry）
// - Session Doc（session:{rcsSessionId}）：session/agent/pendingPermissions
//
// 旧字段（agentInfo/sessions/chatMeta/connection）已从 Y.Doc schema 删除；
// 此处按新结构派生，无法派生的字段给保守默认值。
// modelState/modeState/availableCommands 为会话级元数据：session/new、load 响应的
// models/modes 与 available_commands_update 通知经聚合层投影到 Session Doc session map，
// 此处从嵌套 Y.Map/Y.Array 转换回展示形状。

import type { AgentInfo, ChatStateSnapshot } from "@fenix/chat-channel";
import { createYjsStore, stableKey, type YjsStore } from "@fenix/chat-channel";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { sessionOptionKindsToPermissionOptions } from "../lib/structured-to-thread";

// ── Chat Doc 派生：token 用量（turn 终态写入 assistant entry 的 tokenUsage）──

interface ChatTokenSnapshot {
  tokenUsage: ChatStateSnapshot["tokenUsage"];
}

function computeTokenSnapshot(ydoc: Y.Doc): ChatTokenSnapshot {
  const root = ydoc.getMap("root");
  // Chat Doc 尚未同步（快照未到达）时返回默认值：不得创建未插入 doc 的
  // Y 类型占位后读取（Yjs 会抛 "Invalid access: Add Yjs type to a document..."）
  const order = root.get("entryOrder") as Y.Array<string> | undefined;
  const entries = root.get("entries") as Y.Map<Y.Map<unknown>> | undefined;
  if (!order || !entries) return { tokenUsage: null };

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

/** 从 Session Doc session map 读取 Model 状态（嵌套 Y.Map/Y.Array 结构 → plain object） */
function readModelState(session: Y.Map<unknown> | undefined): ChatStateSnapshot["modelState"] {
  const raw = session?.get("modelState");
  if (!(raw instanceof Y.Map)) return null;
  const currentModelId = raw.get("currentModelId");
  const models = raw.get("availableModels");
  if (typeof currentModelId !== "string" || !(models instanceof Y.Array)) return null;
  const availableModels: Array<{ modelId: string; name: string }> = [];
  for (const m of models) {
    if (!(m instanceof Y.Map)) continue;
    availableModels.push({
      modelId: String(m.get("modelId") ?? ""),
      name: String(m.get("name") ?? ""),
    });
  }
  if (availableModels.length === 0) return null;
  return { currentModelId, availableModels };
}

/** 从 Session Doc session map 读取 Mode 状态（嵌套 Y.Map/Y.Array 结构 → plain object） */
function readModeState(session: Y.Map<unknown> | undefined): ChatStateSnapshot["modeState"] {
  const raw = session?.get("modeState");
  if (!(raw instanceof Y.Map)) return null;
  const currentModeId = raw.get("currentModeId");
  const modes = raw.get("availableModes");
  if (typeof currentModeId !== "string" || !(modes instanceof Y.Array)) return null;
  const availableModes: Array<{ id: string; name: string; description?: string | null }> = [];
  for (const m of modes) {
    if (!(m instanceof Y.Map)) continue;
    availableModes.push({
      id: String(m.get("id") ?? ""),
      name: String(m.get("name") ?? ""),
      description: (m.get("description") as string | null | undefined) ?? null,
    });
  }
  if (availableModes.length === 0) return null;
  return { currentModeId, availableModes };
}

/** 从 Session Doc session map 读取可用命令列表（available_commands_update 投影，slash 命令菜单数据源） */
function readAvailableCommands(session: Y.Map<unknown> | undefined): ChatStateSnapshot["availableCommands"] {
  const raw = session?.get("availableCommands");
  if (!(raw instanceof Y.Array)) return [];
  const commands: ChatStateSnapshot["availableCommands"] = [];
  for (const c of raw) {
    if (!(c instanceof Y.Map)) continue;
    // input 存储形状为 null 或 { hint }，读取时 null 直接省略字段（与 acp-link
    // AvailableCommand 展示类型一致，避免 null 泄漏到 UI 层）
    const input = c.get("input");
    const cmd: ChatStateSnapshot["availableCommands"][number] = {
      name: String(c.get("name") ?? ""),
      description: String(c.get("description") ?? ""),
    };
    if (input && typeof input === "object") {
      cmd.input = { hint: String((input as { hint?: unknown }).hint ?? "") };
    }
    commands.push(cmd);
  }
  return commands;
}

interface ChatMetaSnapshot {
  sessionId: string;
  title: string | null;
  status: string;
  instanceId: string | null;
  acpSessionId: string | null;
  /** 当前会话的 Model 状态（session/new、load 响应投影，会话级元数据） */
  modelState: ChatStateSnapshot["modelState"];
  /** 当前会话的 Mode 状态 */
  modeState: ChatStateSnapshot["modeState"];
  /** 当前会话的可用命令列表 */
  availableCommands: ChatStateSnapshot["availableCommands"];
  capabilities: Record<string, boolean> | null;
  permissions: ChatStateSnapshot["permissions"];
  /** 会话列表（Session Doc sessions 投影派生；含当前会话兜底） */
  sessions: ChatStateSnapshot["sessions"];
}

function computeMetaSnapshot(ydoc: Y.Doc): ChatMetaSnapshot {
  const root = ydoc.getMap("root");
  // Session Doc 尚未同步（快照未到达）时字段缺失按默认值处理；
  // 不得用 new Y.Map() 占位后读取（Yjs 抛 "Invalid access: Add Yjs type to a document..."）
  const session = root.get("session") as Y.Map<unknown> | undefined;
  const agent = root.get("agent") as Y.Map<unknown> | undefined;
  const pending = root.get("pendingPermissions") as Y.Map<Y.Map<unknown>> | undefined;

  const capsMap = agent?.get("capabilities");
  const capabilities: Record<string, boolean> | null =
    capsMap instanceof Y.Map && capsMap.size > 0 ? Object.fromEntries(capsMap.entries()) : null;

  const permissions: ChatStateSnapshot["permissions"] = [];
  if (pending) {
    for (const [permissionId, permission] of pending.entries()) {
      // Session Doc 三态（pending/resolved/expired）→ 前端展示态：
      // 只有 pending 可操作；resolved 按 CAS 落盘的 decision 展示 approved/denied
      // （兼容旧快照：无 decision 字段时 resolved 仍显示 approved）；
      // expired 一律 denied（后端过期不写 decision，保持 null）
      const rawStatus = permission.get("status");
      const decision = permission.get("decision");
      const displayStatus: "pending" | "approved" | "denied" =
        rawStatus === "pending"
          ? "pending"
          : rawStatus === "resolved"
            ? decision === "deny"
              ? "denied"
              : "approved"
            : "denied";
      permissions.push({
        id: permissionId,
        tool: (permission.get("title") as string) || "",
        args: (permission.get("description") as Record<string, unknown> | undefined) ?? undefined,
        level: "ask",
        status: displayStatus,
        ts: permission.get("expiresAt") ? new Date(permission.get("expiresAt") as string).getTime() : 0,
        options: sessionOptionKindsToPermissionOptions(permission.get("options")),
      });
    }
  }

  // 会话列表：Session Doc sessions 投影派生（sessionId/title/updatedAt），
  // 无标题/未命名会话不在 agent 列表时以当前会话兜底（status=active）
  const currentSessionId = session?.get("sessionId") as string | undefined;
  const sessions: ChatStateSnapshot["sessions"] = [];
  const rawSessions = root.get("sessions");
  if (rawSessions instanceof Y.Map) {
    for (const [sessionId, entry] of rawSessions.entries()) {
      sessions.push({
        sessionId,
        title: (entry.get("title") as string | null | undefined) ?? "",
        preview: "",
        status: sessionId === currentSessionId ? "active" : "idle",
        lastMsgTs: 0,
        updatedAt: (entry.get("updatedAt") as string | undefined) ?? undefined,
      });
    }
  }
  if (currentSessionId && !sessions.some((s) => s.sessionId === currentSessionId)) {
    sessions.unshift({
      sessionId: currentSessionId,
      title: (session?.get("title") as string | null | undefined) ?? "",
      preview: "",
      status: "active",
      lastMsgTs: 0,
      updatedAt: undefined,
    });
  }

  return {
    sessionId: currentSessionId ?? "",
    title: (session?.get("title") as string | null | undefined) ?? null,
    status: (session?.get("status") as string | undefined) ?? "initializing",
    instanceId: (agent?.get("instanceId") as string | null | undefined) ?? null,
    acpSessionId: (agent?.get("acpSessionId") as string | null | undefined) ?? null,
    capabilities,
    modelState: readModelState(session),
    modeState: readModeState(session),
    availableCommands: readAvailableCommands(session),
    permissions,
    sessions,
  };
}

// ── 合并快照 ──

function computeChatSnapshot(token: ChatTokenSnapshot, meta: ChatMetaSnapshot): ChatStateSnapshot {
  const agentInfo: AgentInfo = {
    id: meta.instanceId ?? meta.acpSessionId ?? "",
    name: "",
  };

  return {
    agentInfo,
    sessions: meta.sessions,
    activeSessionId: meta.sessionId,
    connection: { status: "disconnected", since: 0 },
    permissions: meta.permissions,
    isSwitchingSession: false,
    capabilities: meta.capabilities,
    modelState: meta.modelState,
    modeState: meta.modeState,
    availableCommands: meta.availableCommands,
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
          modelState: null,
          modeState: null,
          availableCommands: [],
          permissions: [],
          sessions: [],
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
    // StrictMode 双挂载：首次 cleanup 已 destroy store（activeKey 重置为 ""），
    // 重挂载时 prevKeyRef 幂等保护会跳过渲染期 switchDoc，必须在此显式重建当前 doc。
    // 正常挂载时渲染期 switchDoc 已设置 activeKey，此处调用为 no-op（幂等安全）。
    for (const store of [stores.chat, stores.meta]) {
      store.switchDoc(rcsSessionId, () => {
        const ydoc = new Y.Doc();
        return { ydoc };
      });
    }
    return () => {
      stores.chat.destroy();
      stores.meta.destroy();
    };
  }, [stores, rcsSessionId]);

  const applyUpdate = useCallback(
    (docName: string, data: Uint8Array) => {
      if (docName.startsWith("chat:")) stores.chat.applyUpdate(data);
      else stores.meta.applyUpdate(data);
    },
    [stores],
  );

  return { state, applyUpdate };
}
