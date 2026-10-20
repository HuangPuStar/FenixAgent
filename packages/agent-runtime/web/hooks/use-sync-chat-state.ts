// 新协议默认启用；旧连接仍承担历史、非文本与动作通道，不由本 hook 释放。
// 明确不支持协议时锁定旧路径，只有会话/组织切换或显式重新启用才允许再次尝试。

import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncChatProjection } from "../yjs/sync-doc-hub";
import { emptySyncChatProjection } from "../yjs/sync-doc-hub";
import type { SyncChatConnectionState, SyncChatSession } from "../yjs/sync-transport";
import { createSyncChatSession, INITIAL_SYNC_CHAT_STATE } from "../yjs/sync-transport";
import type { SyncBrowserSocketFactory } from "../yjs/yjs-ws";

export interface UseSyncChatStateOptions {
  /** 默认 true；显式 false 不建立新连接。 */
  readonly enabled?: boolean;
  readonly agentId: string | null;
  readonly instanceUid: string | null;
  readonly rcsSessionId: string | null;
  readonly organizationId: string | null;
  /** ACP 会话切换时释放旧投影；不作为协议 generation 发送。 */
  readonly sessionKey?: string | null;
  /**
   * 旧 Chat/Session Doc 的换代版本（DocHub replace 计数）。`load_session` / `create_session`
   * 换代后必须重建同步连接，让服务端按新投影代次选择 store 与历史，而不是把新会话事件
   * 追加到上一会话的时间线上。
   */
  readonly projectionVersion?: number;
  readonly contentDocIds?: readonly string[];
  readonly generation?: string;
  /** 测试注入；生产使用浏览器 WebSocket。 */
  readonly socketFactory?: SyncBrowserSocketFactory;
  readonly url?: string;
}

export interface SyncChatState {
  readonly connection: SyncChatConnectionState;
  readonly projection: SyncChatProjection;
  readonly legacyFallback: boolean;
  readonly history: SyncChatHistoryState;
  /**
   * 发送新消息时回到最新位置：重新订阅被历史加载淘汰的块，实时内容不再中断。
   * 快照状态可缺省，hook 返回时总会提供实现。
   */
  readonly returnToLatestHistory?: () => void;
}

export interface SyncChatHistoryState {
  /** 仍有更早内容可加载（未订阅块或投影窗口外条目）。 */
  readonly hasEarlier: boolean;
  /** 更早块基线尚在途。 */
  readonly loading: boolean;
  /** 显式加载一批更早内容；返回是否产生了新工作。 */
  readonly loadEarlier: () => boolean;
}

const NO_HISTORY: SyncChatHistoryState = Object.freeze({
  hasEarlier: false,
  loading: false,
  loadEarlier: () => false,
});

const EMPTY_STATE: SyncChatState = {
  connection: INITIAL_SYNC_CHAT_STATE,
  projection: emptySyncChatProjection(),
  legacyFallback: false,
  history: NO_HISTORY,
  returnToLatestHistory: () => {},
};

/**
 * 1008/1002 是协议级不可用（禁用、scope/代次拒绝、入口未就绪等），旧 Yjs 通道仍健康，
 * 直接回退以保证输入可用；1011 等内部错误保留错误卡，不伪装成兼容问题。
 */
export function shouldFallbackToLegacy(connection: SyncChatConnectionState): boolean {
  const error = connection.error;
  return (
    connection.status === "error" &&
    (error?.code === "PROTOCOL_VERSION_UNSUPPORTED" || error?.code === "WS_1002" || error?.code === "WS_1008")
  );
}

/** 订阅隔离的消息投影；切换时同步隐藏旧快照，effect 清理负责释放 transport 与 Doc 引用。 */
export function useSyncChatState(options: UseSyncChatStateOptions): SyncChatState {
  const enabled = options.enabled ?? true;
  const scope = JSON.stringify([
    enabled,
    options.agentId,
    options.instanceUid,
    options.rcsSessionId,
    options.organizationId,
    options.sessionKey,
    options.projectionVersion ?? null,
  ]);
  const [snapshot, setSnapshot] = useState({ scope, state: EMPTY_STATE });
  const fallbackScope = useRef<string | null>(null);
  const sessionRef = useRef<SyncChatSession | null>(null);
  const contentKey = options.contentDocIds?.join(",") ?? "";

  useEffect(() => {
    if (fallbackScope.current !== scope) fallbackScope.current = null;
    setSnapshot({ scope, state: EMPTY_STATE });
    if (
      !enabled ||
      options.agentId === null ||
      options.instanceUid === null ||
      options.rcsSessionId === null ||
      options.organizationId === null
    ) {
      return;
    }
    if (fallbackScope.current === scope) {
      setSnapshot({ scope, state: { ...EMPTY_STATE, legacyFallback: true } });
      return;
    }

    let active = true;
    // 投影按动画帧合并：WebSocket 帧各自是独立宏任务，直接 setState 会让每个 DOC_BASE/
    // DOC_UPDATE 触发一次 React 提交；hydrate 期间展示层虽然隐藏，也没有必要逐帧重渲染。
    let pendingProjection: SyncChatProjection | null = null;
    let frameScheduled = false;
    let cancelFrameTask: (() => void) | null = null;
    const cancelFrame = (): void => {
      cancelFrameTask?.();
      cancelFrameTask = null;
      frameScheduled = false;
    };
    const flushProjection = (): void => {
      cancelFrameTask = null;
      frameScheduled = false;
      if (!active || pendingProjection === null) return;
      const projection = pendingProjection;
      pendingProjection = null;
      setSnapshot((previous) => ({ scope, state: { ...previous.state, projection } }));
    };
    const scheduleProjection = (): void => {
      if (frameScheduled) return;
      frameScheduled = true;
      if (typeof requestAnimationFrame === "function") {
        const handle = requestAnimationFrame(flushProjection);
        // 极少数环境只有 rAF 没有 cancel：回调内的 active 判定仍能阻止迟到提交。
        cancelFrameTask = typeof cancelAnimationFrame === "function" ? () => cancelAnimationFrame(handle) : null;
      } else {
        const handle = setTimeout(flushProjection, 0);
        cancelFrameTask = () => clearTimeout(handle);
      }
    };
    const session = createSyncChatSession({
      agentId: options.agentId,
      instanceUid: options.instanceUid,
      rcsSessionId: options.rcsSessionId,
      organizationId: options.organizationId,
      contentDocIds: contentKey.length > 0 ? contentKey.split(",") : [],
      generation: options.generation,
      socketFactory: options.socketFactory,
      url: options.url,
      onState: (connection) => {
        if (!active) return;
        const legacyFallback = shouldFallbackToLegacy(connection);
        setSnapshot((previous) => ({
          scope,
          state: {
            connection,
            legacyFallback,
            projection: legacyFallback ? emptySyncChatProjection() : previous.state.projection,
            history: previous.state.history,
          },
        }));
        if (legacyFallback) {
          console.warn("[sync-chat] fallback to legacy", {
            code: connection.error?.code,
            reason: connection.error?.message,
          });
          fallbackScope.current = scope;
          active = false;
          session.dispose();
        }
      },
      onProjection: (projection) => {
        if (!active) return;
        pendingProjection = projection;
        scheduleProjection();
      },
    });
    session.connect();
    sessionRef.current = session;
    return () => {
      active = false;
      cancelFrame();
      pendingProjection = null;
      if (sessionRef.current === session) sessionRef.current = null;
      session.dispose();
    };
  }, [
    scope,
    enabled,
    options.agentId,
    options.instanceUid,
    options.rcsSessionId,
    options.organizationId,
    contentKey,
    options.generation,
    options.socketFactory,
    options.url,
  ]);

  const loadEarlier = useCallback((): boolean => sessionRef.current?.loadEarlierHistory() ?? false, []);
  const returnToLatestHistory = useCallback((): void => {
    sessionRef.current?.returnToLatestHistory();
  }, []);

  if (snapshot.scope !== scope) return EMPTY_STATE;
  return {
    ...snapshot.state,
    returnToLatestHistory,
    history: {
      hasEarlier: snapshot.state.connection.hasEarlierHistory,
      loading: snapshot.state.connection.historyLoading,
      loadEarlier,
    },
  };
}
