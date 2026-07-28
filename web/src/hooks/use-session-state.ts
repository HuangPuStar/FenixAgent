// web/src/hooks/use-session-state.ts

import type {
  ArtifactRef,
  LoadingState,
  SessionStateSnapshot,
  SessionStatus,
  StructuredMessage,
  ToolRun,
} from "@fenix/acp-server";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { stableKey } from "./yjs-snapshot-key";
import { createYjsStore } from "./yjs-store";

/** 从 Y.Doc 同步读取 SessionStateSnapshot（纯函数，无副作用，不捕获外部 key） */
function computeSessionSnapshot(ydoc: Y.Doc): SessionStateSnapshot {
  const meta = ydoc.getMap("meta");
  const messages = ydoc.getArray("messages");
  const streaming = ydoc.getMap("streaming");
  const tools = ydoc.getMap("tools") as Y.Map<Y.Map<unknown>>;
  const artifacts = ydoc.getArray("artifacts");
  const structuredMessagesArray = ydoc.getArray("structuredMessages") as Y.Array<Y.Map<unknown>>;

  const rawLoading = meta.get("loading") as Record<string, unknown> | null;

  return {
    acpSessionId: (meta.get("acpSessionId") as string) || "",
    status: (meta.get("status") as SessionStatus) || "idle",
    loading: rawLoading
      ? {
          kind: rawLoading.kind as LoadingState["kind"],
          label: rawLoading.label as string | undefined,
          since: rawLoading.since as number,
        }
      : null,
    messages: (messages.toArray() as Y.Map<unknown>[]).map((m) => ({
      role: (m.get("role") as "user" | "assistant") || "assistant",
      content: (m.get("content") as string) || "",
      seq: (m.get("seq") as number) || 0,
      ts: (m.get("ts") as number) || 0,
    })),
    streaming: streaming.size
      ? {
          text: (streaming.get("text") as string) || "",
          reasoning: (streaming.get("reasoning") as string) || "",
        }
      : null,
    tools: new Map(
      Array.from(tools.entries()).map(([k, v]) => [
        k,
        {
          name: (v.get("name") as string) || "",
          status: (v.get("status") as ToolRun["status"]) || "running",
          input: v.get("input"),
          output: v.get("output"),
          startedAt: (v.get("startedAt") as number) || 0,
        },
      ]),
    ),
    artifacts: (artifacts.toArray() as Y.Map<unknown>[]).map((a) => ({
      kind: (a.get("kind") as ArtifactRef["kind"]) || "url",
      url: (a.get("url") as string) || "",
      title: (a.get("title") as string) || "",
      seq: (a.get("seq") as number) || 0,
    })),
    structuredMessages: (structuredMessagesArray.toArray() as Y.Map<unknown>[])
      // biome-ignore lint/suspicious/useIterableCallbackReturn: returns undefined for unknown types, filtered by .filter(Boolean)
      .map((m) => {
        const t = m.get("type") as string;
        if (t === "assistant_message") {
          const rawChunks = (m.get("chunks") as Y.Array<Y.Map<unknown>>)?.toArray() ?? [];
          return {
            type: "assistant_message" as const,
            id: (m.get("id") as string) || "",
            chunks: rawChunks.map((c) => ({
              type: (c.get("type") as "thought" | "message") || "message",
              text: (c.get("text") as string) || "",
            })),
            seq: (m.get("seq") as number) || 0,
            ts: (m.get("ts") as number) || 0,
          } as StructuredMessage;
        }
        if (t === "tool_call") {
          const rawContent = (m.get("content") as Y.Array<Y.Map<unknown>>)?.toArray() ?? [];
          return {
            type: "tool_call" as const,
            id: (m.get("id") as string) || "",
            title: (m.get("title") as string) || "",
            status: (m.get("status") as string) || "running",
            content: rawContent.map((c) => ({
              type: (c.get("type") as string) || "content",
              content: c.get("content") as Record<string, unknown> | undefined,
              path: c.get("path") as string | undefined,
            })),
            rawInput: m.get("rawInput") as Record<string, unknown> | undefined,
            rawOutput: m.get("rawOutput") as Record<string, unknown> | undefined,
          } as StructuredMessage;
        }
        if (t === "user_message") {
          return {
            type: "user_message" as const,
            id: (m.get("id") as string) || "",
            content: (m.get("content") as string) || "",
            seq: (m.get("seq") as number) || 0,
            ts: (m.get("ts") as number) || 0,
          } as StructuredMessage;
        }
        if (t === "plan") {
          const rawEntries = (m.get("entries") as Y.Array<Y.Map<unknown>>)?.toArray() ?? [];
          return {
            type: "plan" as const,
            id: (m.get("id") as string) || "",
            entries: rawEntries.map((e) => ({
              content: (e.get("content") as string) || "",
              priority: (e.get("priority") as "high" | "medium" | "low") || "medium",
              status: (e.get("status") as "pending" | "in_progress" | "completed") || "pending",
            })),
          } as StructuredMessage;
        }
        return;
      })
      .filter(Boolean) as StructuredMessage[],
  };
}

/**
 * Session 领域快照去重 key — 覆盖全部 UI 字段（含 messages content、
 * tool_call output/status、streaming、permission、loading 等）。
 * 使用 stableKey 对整个快照做稳定序列化，任意 UI 字段变化都会触发通知。
 */
function getSessionSnapshotKey(s: SessionStateSnapshot): string {
  return stableKey(s);
}

function getInitialSessionSnapshot(rcsSessionId: string): SessionStateSnapshot {
  return {
    acpSessionId: rcsSessionId,
    status: "idle",
    loading: null,
    messages: [],
    streaming: null,
    tools: new Map(),
    artifacts: [],
    structuredMessages: [],
  };
}

/**
 * 订阅指定 ACP Session 的状态。
 *
 * 使用 useSyncExternalStore + createYjsStore 替代 useState + useEffect + Y.Doc.observe 模式：
 * - getSnapshot 在渲染期间同步执行，消除"幽灵消息"的 stale frame 问题
 * - Y.Doc 的 update 事件统一监听所有变更
 * - rcsSessionId 变化时同步切换 Y.Doc（在渲染函数体内，非 useEffect）
 */
export function useSessionState(rcsSessionId: string) {
  // 1. 创建 store 实例（per-component-instance，通过 ref lazy init 保持稳定）
  const storeRef = useRef<ReturnType<typeof createYjsStore<SessionStateSnapshot>> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createYjsStore<SessionStateSnapshot>(
      computeSessionSnapshot,
      getInitialSessionSnapshot(rcsSessionId),
      getSessionSnapshotKey,
    );
  }
  const store = storeRef.current;

  // 2. key 变化时同步切换 Y.Doc（在渲染期间，非 useEffect）
  //    使用 prevKeyRef 做幂等保护：相同 key 重复切换是 no-op（Strict Mode / Concurrent Mode 安全）
  //    注意：prevKeyRef 必须初始化为 null（非 rcsSessionId），否则首次渲染时 key 相等，switchDoc 被跳过
  const prevKeyRef = useRef<string | null>(null);
  if (prevKeyRef.current !== rcsSessionId) {
    prevKeyRef.current = rcsSessionId;

    store.switchDoc(rcsSessionId, () => {
      const ydoc = new Y.Doc();
      // meta.acpSessionId 字段名不变，但值变为 rcsSessionId（与 doc-factory 保持一致）
      ydoc.getMap("meta").set("acpSessionId", rcsSessionId);
      return { ydoc };
    });
  }

  // 3. useSyncExternalStore — subscribe 和 getSnapshot 是稳定引用
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // 4. 组件卸载时清理 store
  useEffect(() => {
    return () => store.destroy();
  }, [store]);

  // 5. applyUpdate — 向后兼容
  const applyUpdate = useCallback(
    (update: Uint8Array, sessionId?: string) => {
      store.applyUpdate(update, sessionId);
    },
    [store],
  );

  return { state, applyUpdate };
}
