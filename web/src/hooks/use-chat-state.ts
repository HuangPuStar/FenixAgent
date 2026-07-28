// web/src/hooks/use-chat-state.ts

import type { ChatStateSnapshot, ConnectionStatus, SessionSummary } from "@fenix/acp-server";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { computeChatSnapshotKey, createYjsStore } from "./yjs-store";

/** 从 Y.Doc 同步读取 ChatStateSnapshot（纯函数，无副作用） */
function computeChatSnapshot(ydoc: Y.Doc): ChatStateSnapshot {
  const agentInfo = ydoc.getMap("agentInfo");
  const sessions = ydoc.getArray("sessions");
  const chatMeta = ydoc.getMap("chatMeta");
  const connection = ydoc.getMap("connection");
  const permissions = ydoc.getArray("permissions");
  const capabilities = ydoc.getMap("capabilities");
  const modelState = ydoc.getMap("modelState");
  const modeState = ydoc.getMap("modeState");
  const availableCommands = ydoc.getArray("availableCommands");
  const tokenUsage = ydoc.getMap("tokenUsage");

  const model = agentInfo.get("model") as Y.Map<unknown> | undefined;

  // ── capabilities 解析 ──
  const capsObj = capabilities.toJSON() as Record<string, unknown>;
  const capsResolved = Object.keys(capsObj).length > 0 ? capsObj : null;

  // ── modelState 解析 ──
  const msObj = modelState.toJSON() as Record<string, unknown>;
  const modelsArr = modelState.get("availableModels") as Y.Array<Y.Map<unknown>> | undefined;
  const modelStateResolved = msObj.currentModelId
    ? {
        currentModelId: msObj.currentModelId as string,
        availableModels: modelsArr
          ? modelsArr.toArray().map((m) => ({
              modelId: (m.get("modelId") as string) || "",
              name: (m.get("name") as string) || "",
            }))
          : [],
      }
    : null;

  // ── modeState 解析 ──
  const msModeObj = modeState.toJSON() as Record<string, unknown>;
  const modesArr = modeState.get("availableModes") as Y.Array<Y.Map<unknown>> | undefined;
  const modeStateResolved = msModeObj.currentModeId
    ? {
        currentModeId: msModeObj.currentModeId as string,
        availableModes: modesArr
          ? modesArr.toArray().map((m) => ({
              id: (m.get("id") as string) || "",
              name: (m.get("name") as string) || "",
              description: m.get("description") as string | undefined,
            }))
          : [],
      }
    : null;

  // ── availableCommands 解析 ──
  const cmdsArr = availableCommands.toArray() as Y.Map<unknown>[];
  const commandsResolved = cmdsArr.map((c) => ({
    name: (c.get("name") as string) || "",
    description: (c.get("description") as string) || "",
  }));

  // ── tokenUsage 解析 ──
  const tuObj = tokenUsage.toJSON() as Record<string, unknown>;
  const tokenUsageResolved =
    tuObj.totalTokens != null
      ? {
          totalTokens: tuObj.totalTokens as number,
          inputTokens: tuObj.inputTokens as number,
          outputTokens: tuObj.outputTokens as number,
        }
      : null;

  return {
    agentInfo: {
      id: (agentInfo.get("id") as string) || "",
      name: (agentInfo.get("name") as string) || "",
      model: model
        ? {
            id: (model.get("id") as string) || "",
            name: (model.get("name") as string) || "",
          }
        : undefined,
    },
    sessions: (sessions.toArray() as Y.Map<unknown>[]).map((s) => ({
      sessionId: (s.get("sessionId") as string) || "",
      title: (s.get("title") as string) || "",
      preview: (s.get("preview") as string) || "",
      status: (s.get("status") as SessionSummary["status"]) || "idle",
      lastMsgTs: (s.get("lastMsgTs") as number) || 0,
      cwd: s.get("cwd") as string | undefined,
      updatedAt: s.get("updatedAt") as string | undefined,
    })),
    activeSessionId: (chatMeta.get("activeSessionId") as string) || "",
    isSwitchingSession: (chatMeta.get("isSwitchingSession") as boolean) || false,
    connection: {
      status: (connection.get("status") as ConnectionStatus["status"]) || "disconnected",
      since: (connection.get("since") as number) || 0,
    },
    permissions: (permissions.toArray() as Y.Map<unknown>[]).map((p) => ({
      id: (p.get("id") as string) || "",
      tool: (p.get("tool") as string) || "",
      args: p.get("args"),
      level: "ask" as const,
      status: (p.get("status") as "pending" | "approved" | "denied") || "pending",
      ts: (p.get("ts") as number) || 0,
    })),
    capabilities: capsResolved,
    modelState: modelStateResolved,
    modeState: modeStateResolved,
    availableCommands: commandsResolved,
    tokenUsage: tokenUsageResolved,
  };
}

function getInitialChatSnapshot(): ChatStateSnapshot {
  return {
    agentInfo: { id: "", name: "" },
    sessions: [],
    activeSessionId: "",
    connection: { status: "disconnected", since: 0 },
    permissions: [],
    isSwitchingSession: false,
    capabilities: null,
    modelState: null,
    modeState: null,
    availableCommands: [],
    tokenUsage: null,
  };
}

/**
 * 订阅 chat 级别状态（以 rcsSessionId 为 key）。
 *
 * 使用 useSyncExternalStore + createYjsStore 替代 useState + useEffect + Y.Doc.observe 模式。
 */
export function useChatState(rcsSessionId: string) {
  // 1. 创建 store 实例（per-component-instance，通过 ref lazy init 保持稳定）
  const storeRef = useRef<ReturnType<typeof createYjsStore<ChatStateSnapshot>> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createYjsStore<ChatStateSnapshot>(
      computeChatSnapshot,
      getInitialChatSnapshot(),
      computeChatSnapshotKey,
    );
  }
  const store = storeRef.current;

  // 2. key 变化时同步切换 Y.Doc（在渲染期间，非 useEffect）
  //    key = rcsSessionId，rcsSessionId 变化即重建 Y.Doc
  //    注意：prevKeyRef 必须初始化为 null（非 key），否则首次渲染时 key 相等，switchDoc 被跳过
  const prevKeyRef = useRef<string | null>(null);
  if (prevKeyRef.current !== rcsSessionId) {
    prevKeyRef.current = rcsSessionId;

    store.switchDoc(rcsSessionId, () => {
      const ydoc = new Y.Doc();
      return { ydoc };
    });
  }

  // 3. useSyncExternalStore
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // 4. 组件卸载时清理 store
  useEffect(() => {
    return () => store.destroy();
  }, [store]);

  // 5. applyUpdate — 向后兼容
  const applyUpdate = useCallback(
    (update: Uint8Array) => {
      store.applyUpdate(update);
    },
    [store],
  );

  return { state, applyUpdate };
}
