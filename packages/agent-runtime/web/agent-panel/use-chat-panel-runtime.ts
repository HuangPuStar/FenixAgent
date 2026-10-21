// ChatPanel 的连接、历史同步与投影视图；动作回执由 useChatPanelActions 独立管理。

import {
  type ActionError,
  createDeterministicRcsSessionId,
  PERI_USER_INPUT_QUEUE_CAPABILITY,
  type PublicErrorInfo,
  type TerminalWsUiCode,
  type YjsHistoryIncomplete,
} from "@fenix/chat-channel";
import { useChatPageVisible } from "@fenix/web-runtime/hooks/use-page-visible";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatAuthState } from "../hooks/chat-auth-state";
import { resolveNoReplaySession } from "../hooks/chat-replay-signal";
import type { ChatWsConnectionState } from "../hooks/chat-visible-reconnect";
import { applyChatHydration, useChatHydration } from "../hooks/use-chat-hydration";
import { useChatState } from "../hooks/use-chat-state";
import { useDocHubReplacementVersion } from "../hooks/use-doc-hub-replacement";
import { useSessionState } from "../hooks/use-session-state";
import { useSyncChatState } from "../hooks/use-sync-chat-state";
import { useUserInputQueue } from "../hooks/use-user-input-queue";
import { useYjsDebugDump } from "../hooks/use-yjs-debug-dump";
import { applyDocHubUpdate, getDocHubGenerations, getDocHubStateVectors, replaceDocHubUpdate } from "../yjs/doc-hub";
import {
  buildYjsUrl,
  createYjsWs,
  readSyncChatOrganizationId,
  readSyncChatSwitch,
  resolveYjsWsCloseOutcome,
  type YjsWsState,
} from "../yjs/yjs-ws";
import type { UsePeriTaskViews } from "./chat-panel-host-ports";
import type { ChatPanelDerivedState, ChatPanelRuntime } from "./chat-panel-runtime-types";
import { useStableSyncSessionKey } from "./stable-sync-session-key";
import { useChatPanelActions } from "./use-chat-panel-actions";

export type { ChatPanelCallbacks, ChatPanelRuntime } from "./chat-panel-runtime-types";
export type { StableSyncSessionKeyState } from "./stable-sync-session-key";
export { deriveStableSyncSessionKey, useStableSyncSessionKey } from "./stable-sync-session-key";

import { shouldBlockPromptOnIncompleteLegacy } from "./sync-authority";

/** 重试态最长持续时间：完整快照未到也要恢复重试入口，不能让门禁永久锁死。 */
const HISTORY_RECOVERY_RETRY_TIMEOUT_MS = 10_000;

/**
 * 装配 ChatPanel 的运行时。`agentId` 为空时不建连；`sessionId` 参与 RCS session id 派生，
 * 因此同一 agent 的不同会话拥有各自独立的 Y.Doc。
 *
 * `authState` / `userId` 与 `usePeriTaskViews` 由宿主注入（见 `chat-panel-host-ports.ts`）：前者来自
 * `@fenix/identity/web` 的 `useSession`（platform-impl，本包不得依赖），后者是本包 Y.Doc 上的 Peri Task
 * 投影订阅（owner 是 `@fenix/resource-task`，资源包同样不得依赖）。`userId` 与 `authState` 必须来自宿主的
 * 同一次 `useSession()`：`authState === "ready"` 与 `userId` 有值是同一个事实的两面，分开取数会引入竞态。
 */
export function useChatPanelRuntime({
  agentId,
  sessionId,
  authState,
  userId,
  usePeriTaskViews,
}: {
  agentId: string | null;
  sessionId?: string | null;
  authState: ChatAuthState;
  userId: string | undefined;
  usePeriTaskViews: UsePeriTaskViews;
}): ChatPanelRuntime {
  const [connectionState, setConnectionState] = useState<ChatWsConnectionState>("disconnected");
  const [classifiedError, setClassifiedError] = useState<PublicErrorInfo | null>(null);
  // 最近一次 action_error（transient banner，5s 自动清除）；不进入 errorCode 连接状态机，
  // 避免单动作失败触发整屏错误态
  const [actionError, setActionError] = useState<ActionError | null>(null);
  // 旧 Chat Doc 初始同步未完成：保留服务端给出的缺失文档与超限尺寸，渲染层据此显示重试入口。
  const [historyRecovery, setHistoryRecovery] = useState<YjsHistoryIncomplete | null>(null);
  const [historyRecoveryRetrying, setHistoryRecoveryRetrying] = useState(false);
  // 用户手动重试历史同步：+1 作为建连 effect 依赖强制重建旧 Yjs 连接。
  const [historyRecoveryAttempt, setHistoryRecoveryAttempt] = useState(0);
  // 重试期间只有「缺失文档本身被重新交付」才算恢复完成；连接建立或清空状态都不是证据。
  const historyRecoveryRef = useRef<YjsHistoryIncomplete | null>(null);
  const pendingRecoveryDocsRef = useRef<Set<string> | null>(null);
  const recoveryRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  historyRecoveryRef.current = historyRecovery;
  // 手动重连计数器：点击「重连」按钮时 +1，作为连接 effect 的依赖强制重建 WS。
  // 4500、4502 等同一 URL 无法恢复的关闭码仍需用户手动触发；Chat idle/activity
  // 与客户端 keepalive 超时不再由服务端主动断开。
  // 非终态断开（网络抖动/服务端重启）后客户端会自动重连：标记后 UI 展示轻提示，
  // 而不是整屏"已断开"（终态断开才需要手动干预）。connecting/connected 时清除。
  const [autoReconnecting, setAutoReconnecting] = useState(false);
  // 终态关闭码的 UI 语义（策略表 uiCode）：只有终态关闭才有值，新连接开始时清空。
  const [terminalUiCode, setTerminalUiCode] = useState<TerminalWsUiCode | null>(null);
  const yjsWsRef = useRef<ReturnType<typeof createYjsWs> | null>(null);
  const pageVisible = useChatPageVisible();
  /** 本地新建会话没有历史回放：门控不得用骨架替换空状态。 */
  const noReplaySessionRef = useRef(false);
  /** 保存服务端 Action 公开错误；不按重试语义分支或自动清除诊断标识。 */
  const showActionError = useCallback((err: ActionError) => setActionError(err), []);
  const clearRecoveryRetryTimer = useCallback(() => {
    if (recoveryRetryTimerRef.current !== null) {
      clearTimeout(recoveryRetryTimerRef.current);
      recoveryRetryTimerRef.current = null;
    }
  }, []);
  const settleHistoryRecovery = useCallback(() => {
    pendingRecoveryDocsRef.current = null;
    clearRecoveryRetryTimer();
    historyRecoveryRef.current = null;
    setHistoryRecovery(null);
    setHistoryRecoveryRetrying(false);
  }, [clearRecoveryRetryTimer]);
  /** 缺失文档重新交付一次即证明本轮快照已恢复；全部到齐才解除发送门禁。 */
  const noteRecoveredDoc = useCallback(
    (docName: string) => {
      const pending = pendingRecoveryDocsRef.current;
      if (pending === null || !pending.delete(docName)) return;
      if (pending.size > 0) return;
      settleHistoryRecovery();
    },
    [settleHistoryRecovery],
  );
  const recordHistoryIncomplete = useCallback(
    (info: YjsHistoryIncomplete) => {
      // 同一连接上的迟到增量不是恢复证明，解除等待后只能由下一次建连重新开启跟踪。
      pendingRecoveryDocsRef.current = null;
      clearRecoveryRetryTimer();
      historyRecoveryRef.current = info;
      setHistoryRecovery(info);
      setHistoryRecoveryRetrying(false);
    },
    [clearRecoveryRetryTimer],
  );
  const armHistoryRecoveryTracking = useCallback(() => {
    const recovery = historyRecoveryRef.current;
    pendingRecoveryDocsRef.current = recovery === null ? null : new Set(recovery.docs);
  }, []);
  const retryHistoryRecovery = useCallback(() => {
    if (historyRecoveryRef.current === null) return;
    setClassifiedError(null);
    setHistoryRecoveryRetrying(true);
    clearRecoveryRetryTimer();
    recoveryRetryTimerRef.current = setTimeout(() => {
      recoveryRetryTimerRef.current = null;
      // 快照未到也恢复重试入口；历史缺失状态继续保留，门禁不能因超时被误解除。
      setHistoryRecoveryRetrying(false);
    }, HISTORY_RECOVERY_RETRY_TIMEOUT_MS);
    setHistoryRecoveryAttempt((attempt) => attempt + 1);
  }, [clearRecoveryRetryTimer]);
  // 重试定时器跨连接存活；只在组件卸载时清理，不能在连接重建 effect 的 cleanup 里清掉。
  useEffect(() => () => clearRecoveryRetryTimer(), [clearRecoveryRetryTimer]);
  // ── Yjs 被动观察（旁路，不改变现有逻辑）──
  // 登录态驱动 rcsSessionKey 与建连守卫；宿主注入的 authState 未就绪/失败时不得建连，
  // 否则服务端快照会落入错误 Y.Doc 命名空间（历史竞态根因）。
  // rcsSessionKey: 与服务端一致的 RCS session ID (由 agentId + userId + sessionId 确定性生成)
  // Y.Doc key 必须与此匹配，否则 sessionId guard 会拦截所有 yjs:update
  // sessionId 纳入标识后，同一 agent 不同实例拥有独立的 YJS doc，避免多实例数据串扰
  const rcsSessionKey =
    agentId && userId ? createDeterministicRcsSessionId(agentId, userId, sessionId ?? undefined) : undefined;
  // DocHub 绑定 key（SP-B1）：两个 hook 必须绑定同一会话的同一份共享 doc。
  // 登录态未就绪时使用占位 key（此时建连守卫不会放行 WS，占位 doc 恒为空）
  const docHubKey = rcsSessionKey ?? `__pending_${agentId ?? "unknown"}`;
  // 默认新协议读取文本；旧连接保留历史、非文本和动作，直到新协议拥有完整历史恢复能力。
  const { state: chatState } = useChatState(docHubKey);
  const { state: legacySessionState } = useSessionState(docHubKey);
  // ACP id 从空到首个值的补全不重建同步投影；只有真实会话切换才改变 sessionKey。
  const syncSessionKey = useStableSyncSessionKey(docHubKey, legacySessionState.acpSessionId);
  const replacementVersion = useDocHubReplacementVersion(docHubKey);
  const syncChatSearch = typeof window === "undefined" ? "" : window.location.search;
  const syncEnabled = readSyncChatSwitch(syncChatSearch);
  const syncChat = useSyncChatState({
    enabled: syncEnabled && authState === "ready",
    agentId,
    instanceUid: sessionId ?? null,
    rcsSessionId: rcsSessionKey ?? null,
    organizationId: readSyncChatOrganizationId(),
    sessionKey: syncSessionKey,
    // 投影换代（load/create）必须换同步连接：服务端按旧 Doc 代次隔离 store 与历史。
    projectionVersion: replacementVersion,
  });
  // 投影换代由 replacementVersion 表达；acpSessionId 补全不得触发第二次 hydrate 门控。
  const mergeScope = `${docHubKey}:${replacementVersion}`;
  // 服务端 replay_complete（含零历史）与本地新建会话都无需等待回放；active 回放优先。
  const noReplaySession = resolveNoReplaySession({
    localCreate: noReplaySessionRef.current,
    replayState: legacySessionState.replayState,
    // timelineEmpty 只用于首次页面加载；会话切换必须等 replay_started/complete 的真实信号。
    timelineEmpty: replacementVersion === 0 && legacySessionState.timelineEmpty === true,
    hasMessages: legacySessionState.structuredMessages.length > 0,
  });
  const syncTerminalError =
    syncChat.connection.status === "error" ||
    (syncChat.connection.status === "closed" && syncChat.connection.error !== null);
  // 同步已失效且旧通道历史不完整：旧通道不是可信权威，继续发送会让新问答落在不可见投影里。
  const syncDegradedBlocked = shouldBlockPromptOnIncompleteLegacy({
    legacyFallback: syncChat.legacyFallback,
    historyIncomplete: historyRecovery !== null,
  });
  // 换代（load/create）后旧通道才是这一代历史的权威：同步连接在新世代的空 Doc 上握手，
  // 回放又不进入同步 ingress，基线里没有可等的内容。继续让 blocked 等它只会把切换拖成 loading。
  // 首次连接（version 0）仍等同步基线，避免首屏先空/半截再补齐。
  const hydrationBlockedBySync = syncChat.connection.hydrating && replacementVersion === 0;
  const hydration = useChatHydration({
    scope: mergeScope,
    legacy: legacySessionState.structuredMessages,
    sync: syncChat.projection.messages,
    sourceReady: connectionState === "connected",
    replayActive: legacySessionState.status === "replaying",
    liveActive: legacySessionState.status === "responding",
    blocked: hydrationBlockedBySync,
    syncTerminalError,
    noReplaySession,
  });
  const sessionState = useMemo(
    () =>
      applyChatHydration(legacySessionState, hydration, {
        syncEnabled,
        legacyFallback: syncChat.legacyFallback,
        noReplaySession,
        syncTerminalError,
      }),
    [legacySessionState, hydration, syncEnabled, syncChat.legacyFallback, noReplaySession, syncTerminalError],
  );

  // ACP session 是连接建立后的可变会话元数据，不属于 YJS transport identity。
  // 仅在真正重建连接时读取最新值用于刷新恢复；后续 session/load 更新不得触发断连。
  const acpSessionIdRef = useRef(sessionState.acpSessionId);
  acpSessionIdRef.current = sessionState.acpSessionId;
  // Peri Task 视图 — 只订阅 Session Doc 的 tasks/taskOrder 子树（DocHub 共享实例，
  // 与上面两个 hook 同一份 doc；Chat Doc token 流不触发本 selector 重算）。
  // 订阅能力由宿主注入（投影 owner 是资源包），调用方式与包内 hook 一致：顶层、无条件、传本包派生的 key。
  const { state: periTaskState } = usePeriTaskViews(docHubKey);
  useYjsDebugDump(chatState, sessionState);

  // 待发送队列 — 同样只订阅 Session Doc（root.userInputQueue 子树），Chat Doc 的流式更新不触发重派生。
  const { state: userInputQueue } = useUserInputQueue(docHubKey);

  const {
    sendViaWs,
    handleActionAck,
    handleActionError,
    handleConnectionLost,
    callbacks,
    preservedPrompt,
    retryPreservedPrompt,
    dismissPreservedPrompt,
  } = useChatPanelActions({
    wsRef: yjsWsRef,
    sessionId: sessionState.acpSessionId,
    noReplaySessionRef,
    syncDegradedBlocked,
    returnToLatestHistory: syncChat.returnToLatestHistory,
    showActionError,
  });

  // 已连接且页面可见时发送客户端 keep_alive，服务端据此判断是否应发送自身的 keepalive 心跳。
  // `connectionState` 是**有意义的依赖**：重连会替换 `yjsWsRef.current` 指向的 socket，状态回到 connected
  // 时本 effect 必须重跑，计时间隔才会绑到新 socket（旧 interval 会因旧 socket 已断开而自清）。因此这里
  // 显式读取状态而不是只把状态列进依赖数组——后者会被 lint（useExhaustiveDependencies）判为多余依赖，
  // 而删掉这个依赖会让重连后不再发送 keep_alive。
  useEffect(() => {
    if (!pageVisible || connectionState !== "connected") return;
    const ws = yjsWsRef.current;
    if (!ws?.isConnected()) return;
    const interval = setInterval(() => {
      if (!ws.isConnected()) {
        clearInterval(interval);
        return;
      }
      ws.send({ type: "keep_alive" });
    }, 30_000);
    return () => clearInterval(interval);
  }, [pageVisible, connectionState]);

  // 创建 YjsWs 连接
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyRecoveryAttempt 是刻意的引用驱动依赖——用户重试历史同步时递增该值，强制重建旧 Yjs 连接。
  useLayoutEffect(() => {
    if (!agentId) {
      setConnectionState("disconnected");
      return;
    }

    // 建连守卫（登录态维度）：userId 未就绪前 rcsSessionKey 无法派生，若此时建连，
    // 服务端快照会落入 __pending_* 占位 doc，switchDoc 后丢失（历史竞态根因）。
    // loading → 渲染层显示"加载用户信息"独立加载态（不占用"连接中"语义）；
    // failed → 明确错误态 + 重试出口，杜绝 auth 悬挂时 UI 永驻转圈的体验黑洞。
    if (authState === "loading") return;
    if (authState === "failed") {
      setConnectionState("error");
      return;
    }

    setConnectionState("connecting");
    // authState === "ready" 时 userId 必有值，此处仅作防御
    if (!rcsSessionKey) return;

    if (!sessionId) return;
    const relayUrl = buildYjsUrl(agentId, {
      instanceUid: sessionId,
      rcsSessionId: rcsSessionKey,
      acpSessionId: acpSessionIdRef.current || undefined,
    });

    const yjsWs = createYjsWs({
      url: relayUrl,
      onYjsUpdate: (docName, data, generation) => {
        try {
          applyDocHubUpdate(rcsSessionKey, docName, generation ?? "", data);
        } catch (err) {
          console.warn("[Yjs] Failed to apply update:", err);
        }
      },
      onYjsReplace: (docName, generation, data) => {
        noteRecoveredDoc(docName);
        replaceDocHubUpdate(rcsSessionKey, docName, generation, data);
      },
      getYjsStateVectors: () => getDocHubStateVectors(rcsSessionKey),
      getYjsGenerations: () => getDocHubGenerations(rcsSessionKey),
      onError: (error) => setClassifiedError(error),
      onHistoryIncomplete: (info) => recordHistoryIncomplete(info),
      // 只有服务端显式确认本轮初始同步完成才算恢复：实时 update 会在握手期间穿插到达，
      // 若拿它当证据，缺失文档尚未交付就会提前解除发送门禁。
      onSyncComplete: (info) => {
        for (const docName of info.docs) noteRecoveredDoc(docName);
      },
      onClose: (close) => {
        handleConnectionLost();
        // 关闭码语义取自策略表（`resolveYjsWsCloseOutcome`，同一份知识，见 yjs-ws.ts）：
        // 终态码（4001 实例回收 / 4002 用户主动停止 / 4004 / 4500 / 4501 / 4502）客户端不会再自动重连，
        // 此时 autoReconnecting 必须为 false——否则 UI 谎报「正在自动重连」，而实际在等用户手动恢复。
        const outcome = resolveYjsWsCloseOutcome(close.code, close.reason);
        setAutoReconnecting(!outcome.terminal);
        // 终态码的 UI 语义留给渲染层；非终态断开（网络抖动/服务端重启）置空，避免上一次的语义残留。
        setTerminalUiCode(outcome.uiCode);
        // 本次重试未拿到快照就断开：失败仍可再次重试，历史缺失状态本身不能提前解除。
        pendingRecoveryDocsRef.current = null;
        clearRecoveryRetryTimer();
        setHistoryRecoveryRetrying(false);
        // 非终态断开必须同步置 disconnected——若保持 connected，UI 显示已连接而 WS 实际
        // 断开，sendViaWs 会静默失败（消息无声消失）；disconnected 渲染分支
        // 由 autoReconnecting 标记展示"正在自动重连"轻提示。
        setConnectionState("disconnected");
      },
      onConnectionState: (state: YjsWsState) => {
        if (state === "connecting") {
          setAutoReconnecting(false);
          // 重试/自动重连开始：历史缺失保持到缺失文档真正重新交付，连接事件不构成恢复证明。
          armHistoryRecoveryTracking();
          // 新连接开始即作废旧终止语义：先前「实例已停止」的空态不得跨过一次成功重连留存。
          setTerminalUiCode(null);
          setConnectionState("connecting");
        } else if (state === "connected") {
          setAutoReconnecting(false);
          setConnectionState("connected");

          // 发送 list_sessions 获取历史会话列表
          // 注意：RCS session ID (session_xxx) ≠ ACP session ID (ses_xxx)，不能直接 load_session
          sendViaWs({ action: "list_sessions" });

          // 自动创建会话逻辑已移至 ACPMain bootstrap（防抖 300ms），
          // 不再使用盲等定时器，避免与 list_sessions 响应产生竞态
        } else if (state === "error") {
          handleConnectionLost();
          // 连接进入错误终态同样结束本次重试态；历史缺失保留，用户可再次点击重试。
          pendingRecoveryDocsRef.current = null;
          clearRecoveryRetryTimer();
          setHistoryRecoveryRetrying(false);
          setConnectionState("error");
        } else {
          handleConnectionLost();
          setConnectionState("disconnected");
        }
      },
      onActionAck: handleActionAck,
      onActionError: handleActionError,
    });

    yjsWs.connect();
    yjsWsRef.current = yjsWs;

    return () => {
      yjsWs.disconnect();
      yjsWsRef.current = null;
    };
    // reconnectAttempt 变化时重建连接：断连（含机器不可用等不自动重连场景）后用户可点击「重连」恢复；
    // sendViaWs / handleActionAck / releaseCommandId / showActionError 为稳定 useCallback，
    // rcsSessionKey 变化触发重建（建连守卫，见上）；authState 变化驱动登录态守卫
  }, [
    agentId,
    sessionId,
    rcsSessionKey,
    authState,
    sendViaWs,
    handleActionAck,
    handleActionError,
    handleConnectionLost,
    noteRecoveredDoc,
    recordHistoryIncomplete,
    armHistoryRecoveryTracking,
    clearRecoveryRetryTimer,
    historyRecoveryAttempt,
  ]);

  // 从 chatState 提取 ACPMain 需要的派生状态
  const derivedState = useMemo((): ChatPanelDerivedState => {
    const caps = chatState.capabilities;
    const ms = chatState.modelState;
    const mds = chatState.modeState;

    const promptCaps = caps?.promptCapabilities as { image?: boolean } | undefined;
    const supportsImages = promptCaps?.image === true;

    const modelName = ms
      ? ms.availableModels.find((m: { modelId: string; name: string }) => m.modelId === ms.currentModelId)?.name
      : undefined;

    return {
      supportsImages,
      modelName,
      supportsLoadSession: !!(caps?.loadSession || caps?.sessionCapabilities),
      availableCommands: chatState.availableCommands,
      availableModes: mds?.availableModes ?? [],
      currentModeId: mds?.currentModeId ?? null,
      supportsModeSelection: mds != null && (mds.availableModes?.length ?? 0) > 0,
      // 待发送队列能力位：peri steer 契约键 `peri.userInputQueue`，缺省（旧 agent）为假——
      // 未声明的 agent 上队列交互整体不启用，提交维持直发。
      supportsUserInputQueue: caps?.[PERI_USER_INPUT_QUEUE_CAPABILITY] === true,
      tokenUsage: chatState.tokenUsage,
    };
  }, [
    chatState.capabilities,
    chatState.modelState,
    chatState.modeState,
    chatState.availableCommands,
    chatState.tokenUsage,
  ]);

  return {
    authState,
    connectionState,
    classifiedError,
    actionError,
    preservedPrompt,
    retryPreservedPrompt,
    dismissPreservedPrompt,
    historyRecovery,
    historyRecoveryRetrying,
    syncDegradedBlocked,
    retryHistoryRecovery,
    autoReconnecting,
    terminalUiCode,
    rcsSessionKey,
    historyScopeKey: mergeScope,
    chatState,
    sessionState,
    syncChat,
    periTasks: periTaskState.tasks,
    periTasksLoaded: periTaskState.loaded,
    userInputQueue,
    derivedState,
    callbacks,
  };
}
