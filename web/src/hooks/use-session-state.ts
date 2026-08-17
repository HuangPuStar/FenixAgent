// web/src/hooks/use-session-state.ts
// 订阅两份 Y.Doc 派生 SessionStateSnapshot（展示形状保持，数据来源切到新 schema）：
// - Chat Doc（chat:{rcsSessionId}）= 消息时间线：entries/blocks/toolCalls
// - Session Doc（session:{rcsSessionId}）= 会话元信息：session.presenting/loading/canCancel
//   展示态投影字段（后端聚合层 setActiveTurn 统一投影）+ agent
//
// 展示态（status/loading/canCancel）为纯读后端投影字段，前端零派生；
// 职责错位纠正后时间线在 Chat Doc。
// Y.Doc 副本合一（SP-B1 / 根因 B1）：两份 doc 从 DocHub 取共享实例（引用计数），
// 本 hook 只读派生，WS update 由 ChatPanel 经 hub 单写（不再自带 applyUpdate）。

import type {
  LoadingState,
  PermissionOption,
  SessionDocStatus,
  SessionStateSnapshot,
  SessionStatus,
} from "@fenix/chat-channel";
import { createYjsStore, type YjsStore } from "@fenix/chat-channel";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { chatDocEntriesToStructuredMessages, sessionOptionKindsToPermissionOptions } from "../lib/structured-to-thread";
import { createChatDocBinding, createSessionDocBinding } from "../yjs/doc-hub";

// ── Chat Doc 派生：时间线（消息/工具/资源）──

interface SessionTimelineSnapshot {
  structuredMessages: SessionStateSnapshot["structuredMessages"];
}

/** 从 Chat Doc 派生时间线快照（纯函数，无副作用） */
function computeTimelineSnapshot(ydoc: Y.Doc): SessionTimelineSnapshot {
  const root = ydoc.getMap("root");
  const order = root.get("entryOrder") as Y.Array<string> | undefined;
  const entries = root.get("entries") as Y.Map<Y.Map<unknown>> | undefined;

  // Chat Doc 尚未同步（快照未到达）时返回空时间线：不得创建未插入 doc 的
  // Y 类型占位后读取（Yjs 会抛 "Invalid access: Add Yjs type to a document..."）
  if (!order || !entries) {
    return { structuredMessages: [] };
  }

  // 注：历史派生字段 messages/streaming/tools/artifacts 已删除（SP-B2 死字段，
  // 全仓零消费），此处只保留唯一被消费的 structuredMessages；流式状态、工具
  // 执行态均已由后端投影字段（session.presenting/loading）与 toolCall 块承载。
  return { structuredMessages: chatDocEntriesToStructuredMessages(ydoc) };
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
    structuredMessages,
  };
}

/**
 * 订阅指定 RCS 会话的会话状态（时间线 + 展示态投影元信息）。
 * 内部双 store（Chat Doc / Session Doc）绑定 DocHub 的共享 doc 实例
 * （SP-B1），WS update 由 ChatPanel 经 applyDocHubUpdate 单写，本 hook 只读派生。
 */
export function useSessionState(rcsSessionId: string) {
  const storeRef = useRef<{
    chat: YjsStore<SessionTimelineSnapshot>;
    meta: YjsStore<SessionMetaSnapshot>;
  } | null>(null);
  if (!storeRef.current) {
    storeRef.current = {
      chat: createYjsStore<SessionTimelineSnapshot>(computeTimelineSnapshot, { structuredMessages: [] }),
      meta: createYjsStore<SessionMetaSnapshot>(computeMetaSnapshot, {
        acpSessionId: "",
        sessionStatus: null,
        presenting: "idle",
        loading: null,
        canCancel: false,
        permissionOptions: new Map(),
      }),
    };
  }
  const stores = storeRef.current;

  // 绑定工厂：从 DocHub 取共享 doc（ownsDoc=false，生命周期归 hub 引用计数）；
  // useCallback 保持引用稳定，渲染期与 effect 期复用同一工厂
  const bindChatDoc = useCallback(() => createChatDocBinding(rcsSessionId), [rcsSessionId]);
  const bindSessionDoc = useCallback(() => createSessionDocBinding(rcsSessionId), [rcsSessionId]);

  // 重订阅驱动（bind epoch）：destroy 会清空 store listeners（store 契约），
  // 而 useSyncExternalStore 只在 subscribe 引用变化时重订阅——cleanup destroy
  // 后必须重建订阅，否则切换会话 / StrictMode 双挂载后后续 update 不再触发
  // 渲染（快照永久 stale，SP-B1 回归测试捕获的真实缺陷）。
  const [bindEpoch, setBindEpoch] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bindEpoch 不在回调体内使用，作为 subscribe 引用变化的驱动依赖（见上注释）
  const subscribeChat = useCallback((cb: () => void) => stores.chat.subscribe(cb), [bindEpoch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上，bindEpoch 仅驱动引用变化
  const subscribeMeta = useCallback((cb: () => void) => stores.meta.subscribe(cb), [bindEpoch]);

  const timeline = useSyncExternalStore(subscribeChat, stores.chat.getSnapshot);
  const meta = useSyncExternalStore(subscribeMeta, stores.meta.getSnapshot);
  const state = useMemo(() => computeSessionSnapshot(timeline, meta), [timeline, meta]);

  useEffect(() => {
    // doc 绑定只在 effect 期执行（不在渲染期 switchDoc）：渲染期 switchDoc 的
    // notify() 会在渲染进行中触发已订阅组件的 setState（React 报错），且本组件
    // 的 listeners 已被 cleanup destroy 清空，必须经 bindEpoch 重订阅兜底。
    // StrictMode 双挂载 / 切换会话：cleanup destroy 已重置 activeKey（""），
    // 此处 switchDoc 重建 hub 绑定；destroy 经 binding.cleanup 释放 hub 引用，
    // 计数归零才销毁共享 doc。绑定完成后推进 epoch 驱动重订阅。
    stores.chat.switchDoc(rcsSessionId, bindChatDoc);
    stores.meta.switchDoc(rcsSessionId, bindSessionDoc);
    setBindEpoch((e) => e + 1);
    return () => {
      stores.chat.destroy();
      stores.meta.destroy();
    };
  }, [stores, rcsSessionId, bindChatDoc, bindSessionDoc]);

  return { state };
}
