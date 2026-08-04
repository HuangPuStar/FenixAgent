// web/src/hooks/use-session-state.ts
// 订阅两份 Y.Doc 派生 SessionStateSnapshot（展示形状保持，数据来源切到新 schema）：
// - Chat Doc（chat:{rcsSessionId}）= 消息时间线：entries/blocks/toolCalls
// - Session Doc（session:{rcsSessionId}）= 会话元信息：session.activeTurn*/agent
//
// 职责错位纠正后时间线在 Chat Doc；applyUpdate 按 docName 前缀路由到内部 store。

import type { SessionStateSnapshot, SessionStatus, TurnStatus } from "@fenix/chat-channel";
import { createYjsStore, stableKey, type YjsStore } from "@fenix/chat-channel";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { chatDocEntriesToStructuredMessages } from "../lib/structured-to-thread";

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
  const order = (root.get("entryOrder") as Y.Array<string> | undefined) ?? new Y.Array<string>();
  const entries = (root.get("entries") as Y.Map<Y.Map<unknown>> | undefined) ?? new Y.Map<Y.Map<unknown>>();
  const toolCalls = (root.get("toolCalls") as Y.Map<Y.Map<unknown>> | undefined) ?? new Y.Map<Y.Map<unknown>>();

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
    const blocks = (entry.get("blocks") as Y.Map<Y.Map<unknown>> | undefined) ?? new Y.Map<Y.Map<unknown>>();
    const blockOrder = (entry.get("blockOrder") as Y.Array<string> | undefined)?.toArray() ?? [];
    if (kind !== "message") continue;

    const text = blockOrder
      .map((blockId) => {
        const block = blocks.get(blockId);
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
        const block = blocks.get(blockId);
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
  for (const [toolCallId, tool] of toolCalls.entries()) {
    tools.set(toolCallId, {
      name: (tool.get("name") as string) || "",
      status: mapToolRunStatus((tool.get("status") as string) || "running"),
      input: tool.get("arguments"),
      output: tool.get("result"),
      startedAt: 0,
    });
  }

  // artifacts：resource 块（受授权资源引用）
  const artifacts: SessionStateSnapshot["artifacts"] = [];
  for (const entryId of order.toArray()) {
    const entry = entries.get(entryId);
    if (!entry) continue;
    const blocks = (entry.get("blocks") as Y.Map<Y.Map<unknown>> | undefined) ?? new Y.Map<Y.Map<unknown>>();
    for (const block of blocks.values()) {
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

// ── Session Doc 派生：元信息（turn 状态/agent）──

interface SessionMetaSnapshot {
  acpSessionId: string;
  turnStatus: TurnStatus | null;
  turnUpdatedAt: number | null;
}

function computeMetaSnapshot(ydoc: Y.Doc): SessionMetaSnapshot {
  const root = ydoc.getMap("root");
  const session = (root.get("session") as Y.Map<unknown> | undefined) ?? new Y.Map<unknown>();
  const agent = (root.get("agent") as Y.Map<unknown> | undefined) ?? new Y.Map<unknown>();
  return {
    acpSessionId: (agent.get("acpSessionId") as string | undefined) ?? "",
    turnStatus: (session.get("activeTurnStatus") as TurnStatus | undefined) ?? null,
    turnUpdatedAt: (session.get("activeTurnUpdatedAt") as number | undefined) ?? null,
  };
}

/** Turn 状态机 → 展示状态（accepting→思考中、awaiting_permission→等待授权、running→回复中…） */
function mapTurnStatus(turnStatus: TurnStatus | null): SessionStatus {
  switch (turnStatus) {
    case "accepting":
      return "loading";
    case "running":
      return "responding";
    case "awaiting_permission":
      return "waiting-user";
    case "cancelling":
      return "loading";
    case "completed":
    case "cancelled":
    case "interrupted":
      return "done";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

// ── 合并快照 ──

function computeSessionSnapshot(timeline: SessionTimelineSnapshot, meta: SessionMetaSnapshot): SessionStateSnapshot {
  const turnStatus = meta.turnStatus;
  return {
    acpSessionId: meta.acpSessionId,
    status: mapTurnStatus(turnStatus),
    loading:
      turnStatus === "accepting" || turnStatus === "cancelling"
        ? { kind: "session/respond", since: meta.turnUpdatedAt ?? Date.now() }
        : null,
    messages: timeline.messages,
    structuredMessages: timeline.structuredMessages,
    streaming: timeline.streaming,
    tools: timeline.tools,
    artifacts: timeline.artifacts,
  };
}

/**
 * 订阅指定 RCS 会话的会话状态（时间线 + turn 元信息）。
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
        { acpSessionId: "", turnStatus: null, turnUpdatedAt: null },
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
