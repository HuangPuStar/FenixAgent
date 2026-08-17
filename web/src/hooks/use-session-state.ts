// web/src/hooks/use-session-state.ts
// 订阅两份 Y.Doc 派生 SessionStateSnapshot（展示形状保持，数据来源切到新 schema）：
// - Chat Doc（chat:{rcsSessionId}）= 消息时间线：entries/blocks/toolCalls
// - Session Doc（session:{rcsSessionId}）= 会话元信息：session.presenting/loading/canCancel
//   展示态投影字段（后端聚合层 setActiveTurn 统一投影）+ agent
//
// 展示态（status/loading/canCancel）为纯读后端投影字段，前端零派生；
// 职责错位纠正后时间线在 Chat Doc；applyUpdate 按 docName 前缀路由到内部 store。

import type {
  LoadingState,
  PermissionOption,
  SessionDocStatus,
  SessionStateSnapshot,
  SessionStatus,
} from "@fenix/chat-channel";
import { createYjsStore, stableKey, type YjsStore } from "@fenix/chat-channel";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { chatDocEntriesToStructuredMessages, sessionOptionKindsToPermissionOptions } from "../lib/structured-to-thread";

// ── Chat Doc 派生：时间线（消息/工具/资源）──

interface SessionTimelineSnapshot {
  structuredMessages: SessionStateSnapshot["structuredMessages"];
  streaming: SessionStateSnapshot["streaming"];
  tools: SessionStateSnapshot["tools"];
  artifacts: SessionStateSnapshot["artifacts"];
  messages: SessionStateSnapshot["messages"];
}

/** 从 Chat Doc 派生时间线快照（纯函数，无副作用） */
function computeTimelineSnapshot(ydoc: Y.Doc): SessionTimelineSnapshot {
  const root = ydoc.getMap("root");
  const order = root.get("entryOrder") as Y.Array<string> | undefined;
  const entries = root.get("entries") as Y.Map<Y.Map<unknown>> | undefined;
  const toolCalls = root.get("toolCalls") as Y.Map<Y.Map<unknown>> | undefined;

  // Chat Doc 尚未同步（快照未到达）时返回空时间线：不得创建未插入 doc 的
  // Y 类型占位后读取（Yjs 会抛 "Invalid access: Add Yjs type to a document..."）
  if (!order || !entries) {
    return { structuredMessages: [], streaming: null, tools: new Map(), artifacts: [], messages: [] };
  }

  const structuredMessages = chatDocEntriesToStructuredMessages(ydoc);

  // messages：按时间线顺序的扁平消息（含 user/assistant 文本）
  const messages: SessionStateSnapshot["messages"] = [];
  let streaming: SessionStateSnapshot["streaming"] = null;

  for (const entryId of order.toArray()) {
    const entry = entries.get(entryId);
    if (!entry) continue;
    const kind = entry.get("kind") as string | undefined;
    const role = entry.get("role") as string | undefined;
    const status = entry.get("status") as string | undefined;
    const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
    const blockOrder = (entry.get("blockOrder") as Y.Array<string> | undefined)?.toArray() ?? [];
    if (kind !== "message") continue;

    const text = blockOrder
      .map((blockId) => {
        const block = blocks?.get(blockId);
        const blockType = block?.get("type");
        const blockText = block?.get("text");
        return blockType === "text" && blockText instanceof Y.Text ? blockText.toString() : "";
      })
      .filter(Boolean)
      .join("\n");

    messages.push({
      role: (role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: text,
      seq: messages.length,
      ts: entry.get("createdAt") ? new Date(entry.get("createdAt") as string).getTime() : Date.now(),
    });

    // 流式状态：status === streaming 的 assistant entry 的 text/reasoning 增量
    if (status === "streaming" && role === "assistant") {
      let textChunk = "";
      let reasoningChunk = "";
      for (const blockId of blockOrder) {
        const block = blocks?.get(blockId);
        if (!block) continue;
        const blockType = block.get("type") as string | undefined;
        const blockText = block.get("text");
        const value = blockText instanceof Y.Text ? blockText.toString() : "";
        if (blockType === "text") textChunk = value;
        else if (blockType === "reasoning") reasoningChunk = value;
      }
      streaming = { text: textChunk, reasoning: reasoningChunk };
    }
  }

  // tools：toolCalls 投影
  const tools: SessionStateSnapshot["tools"] = new Map();
  if (toolCalls) {
    for (const [toolCallId, tool] of toolCalls.entries()) {
      tools.set(toolCallId, {
        name: (tool.get("name") as string) || "",
        status: mapToolRunStatus((tool.get("status") as string) || "running"),
        input: tool.get("arguments"),
        output: tool.get("result"),
        startedAt: 0,
      });
    }
  }

  // artifacts：resource 块（受授权资源引用）
  const artifacts: SessionStateSnapshot["artifacts"] = [];
  for (const entryId of order.toArray()) {
    const entry = entries.get(entryId);
    if (!entry) continue;
    const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
    for (const block of blocks?.values() ?? []) {
      if (block.get("type") !== "resource") continue;
      const mediaType = (block.get("mediaType") as string) || "";
      artifacts.push({
        kind: mediaType.startsWith("image/") ? "image" : "file",
        url: (block.get("resourceId") as string) || "",
        title: (block.get("name") as string) || "",
        seq: artifacts.length,
      });
    }
  }

  return { structuredMessages, streaming, tools, artifacts, messages };
}

/** ToolCallProjection 状态 → ToolRun 状态 */
function mapToolRunStatus(status: string): "running" | "done" | "error" {
  if (status === "completed") return "done";
  if (status === "error") return "error";
  if (status === "cancelled") return "done";
  return "running";
}

// ── Session Doc 派生：元信息（展示态投影/agent）──

interface SessionMetaSnapshot {
  acpSessionId: string;
  /** Session Doc 会话级状态（session.status，create/load 成功后 "ready"），用于会话就绪判定 */
  sessionStatus: SessionDocStatus | null;
  /** 展示态（后端投影字段 session.presenting 直接读取，前端零派生） */
  presenting: SessionStatus;
  /** 展示态（后端投影字段 session.loading 直接读取） */
  loading: LoadingState | null;
  /** 展示态（后端投影字段 session.canCancel 直接读取） */
  canCancel: boolean;
  /** permissionId → 展示选项（Session Doc pendingPermissions 的 3 值 kind 翻译而来） */
  permissionOptions: Map<string, PermissionOption[]>;
}

function computeMetaSnapshot(ydoc: Y.Doc): SessionMetaSnapshot {
  const root = ydoc.getMap("root");
  // Session Doc 尚未同步（快照未到达）时字段缺失按默认值处理；
  // 不得用 new Y.Map() 占位后读取（Yjs 抛 "Invalid access: Add Yjs type to a document..."）
  const session = root.get("session") as Y.Map<unknown> | undefined;
  const agent = root.get("agent") as Y.Map<unknown> | undefined;
  const pending = root.get("pendingPermissions") as Y.Map<Y.Map<unknown>> | undefined;

  // 行内权限按钮数据源：Session Doc 的 options（3 值 kind）翻译为 acp-link PermissionOption[]
  const permissionOptions = new Map<string, PermissionOption[]>();
  if (pending) {
    for (const [permissionId, permission] of pending.entries()) {
      permissionOptions.set(permissionId, sessionOptionKindsToPermissionOptions(permission.get("options")));
    }
  }

  return {
    // agent.acpSessionId 只在 agent_status 帧投影（连接建立时，值为 null）；
    // create/load 成功后回退读取 session.sessionId（session_updated 投影），
    // 否则前端 send_prompt 永远不带 sessionId（多会话共享 relay 时路由错乱）
    acpSessionId:
      (agent?.get("acpSessionId") as string | undefined) ?? (session?.get("sessionId") as string | undefined) ?? "",
    sessionStatus: (session?.get("status") as SessionDocStatus | undefined) ?? null,
    // 展示态投影字段缺失（Session Doc 尚未同步）时给安全默认值：
    // presenting="idle"、loading=null、canCancel=false
    presenting: (session?.get("presenting") as SessionStatus | undefined) ?? "idle",
    loading: (session?.get("loading") as LoadingState | null | undefined) ?? null,
    canCancel: (session?.get("canCancel") as boolean | undefined) ?? false,
    permissionOptions,
  };
}

// ── 合并快照 ──

/**
 * 合并时间线 + 会话元信息为展示快照（纯函数，无副作用）。
 * 导出仅供测试：直接构造 meta 投影字段验证 status/loading/canCancel 透传
 * （展示态全部来自后端投影字段 session.presenting / session.loading / session.canCancel，
 * 前端零派生；后端 turn 状态机 → 展示态映射由 packages/chat-channel 包内测试覆盖）。
 */
export function computeSessionSnapshot(
  timeline: SessionTimelineSnapshot,
  meta: SessionMetaSnapshot,
): SessionStateSnapshot {
  // 按 permissionRequest.requestId 合并 Session Doc 的真实选项（Chat Doc 侧为占位空数组）
  const structuredMessages = timeline.structuredMessages.map((m) => {
    if (m.type !== "tool_call" || !m.permissionRequest) return m;
    return {
      ...m,
      permissionRequest: {
        requestId: m.permissionRequest.requestId,
        options: meta.permissionOptions.get(m.permissionRequest.requestId) ?? [],
      },
    };
  });
  return {
    acpSessionId: meta.acpSessionId,
    sessionStatus: meta.sessionStatus,
    // 展示态直接透传后端投影字段（presenting/loading/canCancel），前端不再做任何派生
    status: meta.presenting,
    canCancel: meta.canCancel,
    loading: meta.loading,
    messages: timeline.messages,
    structuredMessages,
    streaming: timeline.streaming,
    tools: timeline.tools,
    artifacts: timeline.artifacts,
  };
}

/**
 * 订阅指定 RCS 会话的会话状态（时间线 + 展示态投影元信息）。
 * 内部双 store（Chat Doc / Session Doc），applyUpdate(docName, data) 按前缀路由。
 */
export function useSessionState(rcsSessionId: string) {
  const storeRef = useRef<{
    chat: YjsStore<SessionTimelineSnapshot>;
    meta: YjsStore<SessionMetaSnapshot>;
  } | null>(null);
  if (!storeRef.current) {
    storeRef.current = {
      chat: createYjsStore<SessionTimelineSnapshot>(
        computeTimelineSnapshot,
        { structuredMessages: [], streaming: null, tools: new Map(), artifacts: [], messages: [] },
        (s) => stableKey(s),
      ),
      meta: createYjsStore<SessionMetaSnapshot>(
        computeMetaSnapshot,
        {
          acpSessionId: "",
          sessionStatus: null,
          presenting: "idle",
          loading: null,
          canCancel: false,
          permissionOptions: new Map(),
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

  const timeline = useSyncExternalStore(stores.chat.subscribe, stores.chat.getSnapshot);
  const meta = useSyncExternalStore(stores.meta.subscribe, stores.meta.getSnapshot);
  const state = useMemo(() => computeSessionSnapshot(timeline, meta), [timeline, meta]);

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
