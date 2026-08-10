import { type ActionAck, type ActionError, createDeterministicRcsSessionId } from "@fenix/chat-channel";
import { Bot, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ACPMain } from "@/components/ACPMain";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useChatState } from "../../hooks/use-chat-state";
import { useSessionState } from "../../hooks/use-session-state";
import { useChatPageVisible } from "../../hooks/usePageVisible";
import { NS } from "../../i18n";
import { useSession } from "../../lib/auth-client";
import { buildYjsUrl, createYjsWs, getTerminalYjsWsErrorCode, type YjsWsState } from "../../yjs/yjs-ws";
import { type ChatWsConnectionState, shouldAutoReconnectOnVisible } from "./chat-visible-reconnect";

type WsConnectionState = ChatWsConnectionState;

interface ChatPanelProps {
  agentId: string | null;
  sessionId?: string | null;
  initialCwd?: string;
  hideSidebar?: boolean;
  scenePrompt?: string;
  contextKey?: string;
  onPromptComplete?: () => void;
}

export function ChatPanel({
  agentId,
  sessionId,
  initialCwd,
  hideSidebar,
  scenePrompt,
  contextKey,
  onPromptComplete,
}: ChatPanelProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [connectionState, setConnectionState] = useState<WsConnectionState>("disconnected");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // 最近一次 action_error（transient banner，5s 自动清除）；不进入 errorCode 连接状态机，
  // 避免单动作失败触发整屏错误态
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const actionErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 手动重连计数器：点击「重连」按钮时 +1，作为连接 effect 的依赖强制重建 WS 连接。
  // 服务端以 4001/4500 等关闭码主动断连时（如 machine_unavailable、idle reclaim），
  // WS 客户端不会自动重连，必须由用户手动触发。
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const yjsWsRef = useRef<ReturnType<typeof createYjsWs> | null>(null);
  const pageVisible = useChatPageVisible();

  // 手动重连：立即进入 connecting 状态并递增计数器，useLayoutEffect 清理旧连接后重新建连
  const handleReconnect = useCallback(() => {
    setConnectionState("connecting");
    setErrorCode(null);
    setReconnectAttempt((n) => n + 1);
  }, []);

  /** 展示 action_error transient banner（5s 自动清除），重复错误重置计时 */
  const showActionError = useCallback((err: ActionError) => {
    setActionError(err);
    if (actionErrorTimerRef.current) clearTimeout(actionErrorTimerRef.current);
    actionErrorTimerRef.current = setTimeout(() => setActionError(null), 5000);
  }, []);

  // 卸载清理 banner 计时器，避免卸载后 setState
  useEffect(() => {
    return () => {
      if (actionErrorTimerRef.current) clearTimeout(actionErrorTimerRef.current);
    };
  }, []);

  // 缓存 ChatPanel 从后台切回前台且连接已断开时，自动触发一次与「重连」按钮等价的重连：
  // 后台期间实例可能已被 idle/activity 回收（4001）或客户端 keepalive 超时（4501）断开，
  // 这两类终态关闭码不会触发 YJS 客户端自动重连；切回前台时后端已通过 enter/ensureRunning
  // 恢复实例，前端需重建 WS 才能恢复连接。machine_unavailable（4500）保留手动重试。
  const previousPageVisibleRef = useRef(pageVisible);
  useEffect(() => {
    const wasVisible = previousPageVisibleRef.current;
    previousPageVisibleRef.current = pageVisible;
    if (!shouldAutoReconnectOnVisible(wasVisible, pageVisible, connectionState, errorCode)) return;
    setConnectionState("connecting");
    setErrorCode(null);
    setReconnectAttempt((n) => n + 1);
  }, [pageVisible, connectionState, errorCode]);

  // ── Yjs 被动观察（旁路，不改变现有逻辑）──
  const { data: session } = useSession();
  const userId = session?.user?.id ?? "unknown";

  // rcsSessionKey: 与服务端一致的 RCS session ID (由 agentId + userId + sessionId 确定性生成)
  // Y.Doc key 必须与此匹配，否则 sessionId guard 会拦截所有 yjs:update
  // sessionId 纳入标识后，同一 agent 不同实例拥有独立的 YJS doc，避免多实例数据串扰
  const rcsSessionKey =
    agentId && userId !== "unknown"
      ? createDeterministicRcsSessionId(agentId, userId, sessionId ?? undefined)
      : undefined;

  // Chat Doc — 观察全局 Chat 状态（连接、Agent 信息、会话列表、权限）
  const chatHookKey = rcsSessionKey ?? `__pending_${agentId ?? "unknown"}`;
  const { state: chatState, applyUpdate: chatApplyUpdate } = useChatState(chatHookKey);

  // Session Doc — 按 RCS session ID 命名
  const { state: sessionState, applyUpdate: sessionApplyUpdate } = useSessionState(rcsSessionKey ?? "__placeholder__");

  // 调试：通过 ref 追踪最新 YJS 状态，控制台输入 __yjs_dump__() 查看，不会阻止 GC
  const yjsChatRef = useRef(chatState);
  const yjsSessionRef = useRef(sessionState);
  yjsChatRef.current = chatState;
  yjsSessionRef.current = sessionState;
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__yjs_dump__ = () => {
      console.log("── YJS Chat State ──", yjsChatRef.current);
      console.log("── YJS Session State ──", yjsSessionRef.current);
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__yjs_dump__;
    };
  }, []);

  // ── Action commandId（C3：幂等键，同会话唯一）──
  // 同一 action 意图（action + 业务参数）重试复用同一 commandId；
  // 收到 action_ack（committed/duplicate）或 action_error 后释放缓存，
  // 避免同意图的后续操作被服务端永久去重。
  const commandIdCacheRef = useRef<Map<string, string>>(new Map());

  const commandKey = useCallback((data: Record<string, unknown>): string => {
    const { action, commandId: _ignored, ...rest } = data;
    return `${String(action)}|${JSON.stringify(rest)}`;
  }, []);

  /** 释放 commandId 缓存（按 commandId 反查 key）。仅 committed/duplicate/action_error 后调用。 */
  const releaseCommandId = useCallback((commandId: string) => {
    for (const [key, id] of commandIdCacheRef.current) {
      if (id === commandId) commandIdCacheRef.current.delete(key);
    }
  }, []);

  const handleActionAck = useCallback(
    (ack: ActionAck) => {
      // accepted 仅表示入队（服务端去重表中为 in_flight），commandId 必须保留供重试复用；
      // committed/duplicate 才释放（实现与注释对齐）
      if (ack.status === "committed" || ack.status === "duplicate") releaseCommandId(ack.commandId);
    },
    [releaseCommandId],
  );

  // 发送简单 JSON 命令（替代 client 方法调用）：自动携带 commandId
  const sendViaWs = useCallback(
    (data: Record<string, unknown>) => {
      setErrorCode(null);
      const key = commandKey(data);
      const commandId = commandIdCacheRef.current.get(key) ?? crypto.randomUUID();
      commandIdCacheRef.current.set(key, commandId);
      yjsWsRef.current?.send({ ...data, commandId });
    },
    [commandKey],
  );

  // 已连接且页面可见时发送客户端 keep_alive，服务端据此判断是否应发送自身的 keepalive 心跳。
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectionState 用于 WS 就绪后启动 keepalive
  useEffect(() => {
    if (!pageVisible) return;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectAttempt 仅作为手动重连触发器，未在 effect 内读取
  useLayoutEffect(() => {
    if (!agentId) {
      setConnectionState("disconnected");
      setErrorCode(null);
      return;
    }

    setConnectionState("connecting");
    setErrorCode(null);

    // 建连守卫：userId 异步到达前 rcsSessionKey 未就绪，若此时建连，
    // 服务端快照会落入 __pending_* 占位 doc，switchDoc 后丢失（竞态根因）。
    // key 就绪后 deps 变化触发本 effect 重建连接，快照必然落入正确 key 的 doc。
    // 注意：auth 悬挂（key 永不到达）时 UI 停留在 connecting，属于可接受行为。
    if (!rcsSessionKey) return;

    const relayUrl = buildYjsUrl(agentId, sessionId ?? undefined);

    const yjsWs = createYjsWs({
      url: relayUrl,
      onYjsUpdate: (docName, data) => {
        try {
          // 两个 hook 各自内部按 docName 前缀路由到 Chat Doc / Session Doc store
          chatApplyUpdate(docName, data);
          sessionApplyUpdate(docName, data);
        } catch (err) {
          console.warn("[Yjs] Failed to apply update:", err);
        }
      },
      onError: (error) => {
        if (error.code) setErrorCode(error.code);
      },
      onClose: ({ code }) => {
        const terminalErrorCode = getTerminalYjsWsErrorCode(code);
        if (terminalErrorCode) setErrorCode(terminalErrorCode);
      },
      onConnectionState: (state: YjsWsState) => {
        if (state === "connecting") setConnectionState("connecting");
        else if (state === "connected") {
          setConnectionState("connected");

          // 发送 list_sessions 获取历史会话列表
          // 注意：RCS session ID (session_xxx) ≠ ACP session ID (ses_xxx)，不能直接 load_session
          sendViaWs({ action: "list_sessions" });

          // 自动创建会话逻辑已移至 ACPMain bootstrap（防抖 300ms），
          // 不再使用盲等定时器，避免与 list_sessions 响应产生竞态
        } else if (state === "error") {
          setConnectionState("error");
        } else {
          setConnectionState("disconnected");
        }
      },
      onActionAck: handleActionAck,
      onActionError: (err) => {
        // 服务端错误路径已 clearDedup：释放缓存使同意图重试生成新 commandId，
        // 避免跨轮复用歧义；同时展示 transient banner（不污染 errorCode 连接状态机）
        releaseCommandId(err.commandId);
        showActionError(err);
      },
    });

    yjsWs.connect();
    yjsWsRef.current = yjsWs;

    return () => {
      yjsWs.disconnect();
      yjsWsRef.current = null;
    };
    // reconnectAttempt 变化时重建连接：断连（含机器不可用等不自动重连场景）后用户可点击「重连」恢复；
    // sendViaWs / handleActionAck / releaseCommandId / showActionError 为稳定 useCallback，
    // rcsSessionKey 变化触发重建（建连守卫，见上）
  }, [
    agentId,
    sessionId,
    rcsSessionKey,
    chatApplyUpdate,
    sessionApplyUpdate,
    reconnectAttempt,
    sendViaWs,
    handleActionAck,
    releaseCommandId,
    showActionError,
  ]);

  // 从 chatState 提取 ACPMain 需要的派生状态
  const derivedState = useMemo(() => {
    const caps = chatState.capabilities;
    const ms = chatState.modelState;
    const mds = chatState.modeState;

    const promptCaps = caps?.promptCapabilities as { image?: boolean } | undefined;
    const supportsImages = promptCaps?.image === true;

    const modelName = ms
      ? ms.availableModels.find((m: { modelId: string; name: string }) => m.modelId === ms.currentModelId)?.name
      : // modelState 为空时回退到 agentInfo.model（来自 status 消息）
        (chatState.agentInfo?.model?.name as string) || undefined;

    return {
      supportsImages,
      modelName,
      supportsLoadSession: !!(caps?.loadSession || caps?.sessionCapabilities),
      availableCommands: chatState.availableCommands,
      availableModes: mds?.availableModes ?? [],
      currentModeId: mds?.currentModeId ?? null,
      supportsModeSelection: mds != null && (mds.availableModes?.length ?? 0) > 0,
      // 模型切换（设计 §5.3）：modelState 存在且有可用列表才渲染下拉
      availableModels: ms?.availableModels ?? [],
      currentModelId: ms?.currentModelId ?? null,
      supportsModelSelection: ms != null && (ms.availableModels?.length ?? 0) > 0,
      tokenUsage: chatState.tokenUsage,
    };
  }, [
    chatState.capabilities,
    chatState.modelState,
    chatState.modeState,
    chatState.availableCommands,
    chatState.agentInfo,
    chatState.tokenUsage,
  ]);

  // 为 ACPMain 提供的出站回调
  const callbacks = useMemo(
    () => ({
      onSendPrompt: (contentBlocks: unknown[]) => sendViaWs({ action: "send_prompt", content: contentBlocks }),
      // cancel 携带当前 ACP sessionId：服务端（translator → dispatcher）据此精确路由到
      // 对应 session 的活跃 query，多会话并发下避免取消落在错误的 query；空字符串
      // （会话未建立）时省略字段，服务端 fallback 当前会话（向后兼容旧客户端）。
      onCancel: () => sendViaWs({ action: "cancel", sessionId: sessionState.acpSessionId || undefined }),
      onCreateSession: () => sendViaWs({ action: "create_session" }),
      onLoadSession: (sid: string) => sendViaWs({ action: "load_session", sessionId: sid }),
      onResumeSession: (sid: string) => sendViaWs({ action: "resume_session", sessionId: sid }),
      onListSessions: () => sendViaWs({ action: "list_sessions" }),
      onRenameSession: (sid: string, title: string) => sendViaWs({ action: "rename_session", sessionId: sid, title }),
      onDeleteSession: (sid: string) => sendViaWs({ action: "delete_session", sessionId: sid }),
      onRespondPermission: (requestId: string, optionId: string | null) =>
        sendViaWs({ action: "respond_permission", requestId, optionId }),
      onSetMode: (modeId: string) => sendViaWs({ action: "set_session_mode", modeId }),
      // 运行时切换模型（设计 §5.3）：同会话内切换，服务端拦截校验预选列表，
      // 成功后经 SessionChannel 投影回 Session Doc 回显
      onSetModel: (modelId: string) => sendViaWs({ action: "set_session_model", modelId }),
    }),
    [sendViaWs, sessionState.acpSessionId],
  );

  // 未选中实例 → 欢迎空状态
  if (!agentId) {
    return (
      <div className="agent-welcome-empty">
        <Bot className="h-16 w-16" />
        <p className="title">{t("selectAgent")}</p>
        <p className="desc">{t("selectAgentDesc")}</p>
      </div>
    );
  }

  // 错误状态
  if (connectionState === "error") {
    const isMachineUnavailable = errorCode === "machine_unavailable";
    const isIdleReclaimed = errorCode === "instance_idle_reclaimed";
    const isKeepaliveTimeout = errorCode === "client_keepalive_timeout";
    const isAutoStartDisabled = errorCode === "auto_start_disabled";
    const isMaxSessionsReached = errorCode === "max_sessions_reached";
    const isLaunchSpecBuildFailed = errorCode === "launch_spec_build_failed";
    const isSpawnRejected = isAutoStartDisabled || isMaxSessionsReached || isLaunchSpecBuildFailed;
    const isEnvironmentUnavailable = errorCode === "environment_unavailable";
    const title = isEnvironmentUnavailable
      ? t("environmentUnavailable")
      : isMachineUnavailable || isSpawnRejected
        ? t("instanceStartFailed")
        : t("agentDisconnected");
    const desc = isEnvironmentUnavailable
      ? t("environmentUnavailableDesc")
      : isMachineUnavailable
        ? t("machineUnavailableDesc")
        : isAutoStartDisabled
          ? t("autoStartDisabledDesc")
          : isMaxSessionsReached
            ? t("maxSessionsReachedDesc")
            : isLaunchSpecBuildFailed
              ? t("launchSpecBuildFailedDesc")
              : isIdleReclaimed
                ? t("instanceIdleReclaimedDesc")
                : isKeepaliveTimeout
                  ? t("clientKeepaliveTimeoutDesc")
                  : t("agentOfflineDesc");
    return (
      <div className="agent-welcome-empty">
        <p className="title">{title}</p>
        <p className="desc">{desc}</p>
        <Button variant="outline" onClick={handleReconnect} className="mt-2">
          <RefreshCw className="h-4 w-4" />
          {t("reconnect")}
        </Button>
      </div>
    );
  }

  // 连接中
  if (connectionState === "connecting") {
    return (
      <div className="agent-welcome-empty">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="title">{t("connectingAgent")}</p>
      </div>
    );
  }

  // 已连接 → 渲染 ACPMain
  if (connectionState === "connected") {
    return (
      <TooltipProvider>
        {errorCode && (
          <div
            className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {t("agentRequestFailedDesc")}
          </div>
        )}
        {actionError && (
          <div
            className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {actionError.retryable
              ? t("actionErrorRetryableDesc", { message: actionError.message })
              : t("actionErrorFatalDesc", { message: actionError.message })}
          </div>
        )}
        <ACPMain
          agentId={agentId}
          initialCwd={initialCwd}
          hideSidebar={hideSidebar}
          rcsSessionId={sessionId ?? undefined}
          scenePrompt={scenePrompt}
          contextKey={contextKey}
          onPromptComplete={onPromptComplete}
          chatState={chatState}
          sessionState={sessionState}
          connectionState={connectionState}
          supportsImages={derivedState.supportsImages}
          supportsLoadSession={derivedState.supportsLoadSession}
          modelName={derivedState.modelName}
          tokenUsage={derivedState.tokenUsage}
          availableCommands={derivedState.availableCommands}
          availableModes={derivedState.availableModes}
          currentModeId={derivedState.currentModeId}
          supportsModeSelection={derivedState.supportsModeSelection}
          availableModels={derivedState.availableModels}
          currentModelId={derivedState.currentModelId}
          supportsModelSelection={derivedState.supportsModelSelection}
          {...callbacks}
        />
      </TooltipProvider>
    );
  }

  // 断开（非错误，非连接中）
  return (
    <div className="agent-welcome-empty">
      <p className="title">{t("agentDisconnected")}</p>
      <p className="desc">{t("agentOfflineDesc")}</p>
      <Button variant="outline" onClick={handleReconnect} className="mt-2">
        <RefreshCw className="h-4 w-4" />
        {t("reconnect")}
      </Button>
    </div>
  );
}
