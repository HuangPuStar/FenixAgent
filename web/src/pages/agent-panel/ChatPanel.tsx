import { type ActionAck, type ActionError, createDeterministicRcsSessionId } from "@fenix/chat-channel";
import { Bot, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ACPMain } from "@/components/ACPMain";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useChatState } from "../../hooks/use-chat-state";
import { useSessionState } from "../../hooks/use-session-state";
import { useTaskViews } from "../../hooks/use-task-views";
import { useChatPageVisible } from "../../hooks/usePageVisible";
import { NS } from "../../i18n";
import { useSession } from "../../lib/auth-client";
import { randomUUID } from "../../lib/utils";
import { applyDocHubUpdate } from "../../yjs/doc-hub";
import { buildYjsUrl, createYjsWs, getTerminalYjsWsErrorCode, type YjsWsState } from "../../yjs/yjs-ws";
import { resolveChatAuthState } from "./chat-auth-state";
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
  // 非终态断开（网络抖动/服务端重启）后客户端会自动重连：标记后 UI 展示轻提示，
  // 而不是整屏"已断开"（终态断开才需要手动干预）。connecting/connected 时清除。
  const [autoReconnecting, setAutoReconnecting] = useState(false);
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
  // 登录态驱动 rcsSessionKey 与建连守卫；useSession 未就绪/失败时不得建连，
  // 否则服务端快照会落入错误 Y.Doc 命名空间（历史竞态根因）。
  const { data: session, isPending: sessionPending, error: sessionError, refetch: refetchSession } = useSession();
  const userId = session?.user?.id;
  const authState = resolveChatAuthState({ pending: sessionPending, error: sessionError, userId });

  // rcsSessionKey: 与服务端一致的 RCS session ID (由 agentId + userId + sessionId 确定性生成)
  // Y.Doc key 必须与此匹配，否则 sessionId guard 会拦截所有 yjs:update
  // sessionId 纳入标识后，同一 agent 不同实例拥有独立的 YJS doc，避免多实例数据串扰
  const rcsSessionKey =
    agentId && userId ? createDeterministicRcsSessionId(agentId, userId, sessionId ?? undefined) : undefined;

  // DocHub 绑定 key（SP-B1）：两个 hook 必须绑定同一会话的同一份共享 doc。
  // 登录态未就绪时使用占位 key（此时建连守卫不会放行 WS，占位 doc 恒为空）
  const docHubKey = rcsSessionKey ?? `__pending_${agentId ?? "unknown"}`;

  // Chat Doc — 观察全局 Chat 状态（连接、Agent 信息、会话列表、权限）
  const { state: chatState } = useChatState(docHubKey);

  // Session Doc — 按 RCS session ID 命名（与 chatHook 同一 hub entry，共享 doc 副本）
  const { state: sessionState } = useSessionState(docHubKey);

  // Peri Task 视图 — 只订阅 Session Doc 的 tasks/taskOrder 子树（DocHub 共享实例，
  // 与上面两个 hook 同一份 doc；Chat Doc token 流不触发本 selector 重算）
  const { state: periTaskState } = useTaskViews(docHubKey);

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

  // 发送简单 JSON 命令（替代 client 方法调用）：自动携带 commandId。
  // 返回是否真正发出：WS 未就绪/已断开时返回 false（不静默丢弃——静默失败是
  // "消息无声消失"的根因），由调用方给出 UI 反馈。
  const sendViaWs = useCallback(
    (data: Record<string, unknown>): boolean => {
      const ws = yjsWsRef.current;
      if (!ws?.isConnected()) return false;
      setErrorCode(null);
      const key = commandKey(data);
      const commandId = commandIdCacheRef.current.get(key) ?? randomUUID();
      commandIdCacheRef.current.set(key, commandId);
      ws.send({ ...data, commandId });
      return true;
    },
    [commandKey],
  );

  // 发送动作统一入口：失败（WS 未就绪）时 toast 反馈，避免用户输入无声丢失
  const sendAction = useCallback(
    (data: Record<string, unknown>): boolean => {
      const ok = sendViaWs(data);
      if (!ok) toast.error(t("wsSendFailed"));
      return ok;
    },
    [sendViaWs, t],
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

    // 建连守卫（登录态维度）：userId 未就绪前 rcsSessionKey 无法派生，若此时建连，
    // 服务端快照会落入 __pending_* 占位 doc，switchDoc 后丢失（历史竞态根因）。
    // loading → 渲染层显示"加载用户信息"独立加载态（不占用"连接中"语义）；
    // failed → 明确错误态 + 重试出口，杜绝 auth 悬挂时 UI 永驻转圈的体验黑洞。
    if (authState === "loading") return;
    if (authState === "failed") {
      setConnectionState("error");
      setErrorCode("auth_failed");
      return;
    }

    setConnectionState("connecting");
    setErrorCode(null);
    // authState === "ready" 时 userId 必有值，此处仅作防御
    if (!rcsSessionKey) return;

    const relayUrl = buildYjsUrl(agentId, sessionId ?? undefined);

    const yjsWs = createYjsWs({
      url: relayUrl,
      onYjsUpdate: (docName, data) => {
        try {
          // 单写入口（SP-B1 / 根因 B1）：hub 持有该会话唯一的 Chat/Session doc 副本，
          // 两个 hook 的 store 都绑定在这两份 doc 上——apply 一次即全部可见，
          // 替代原先对两个 hook 各自 applyUpdate 的双写
          applyDocHubUpdate(rcsSessionKey, docName, data);
        } catch (err) {
          console.warn("[Yjs] Failed to apply update:", err);
        }
      },
      onError: (error) => {
        if (error.code) setErrorCode(error.code);
      },
      onClose: ({ code, reason }) => {
        const terminalErrorCode = getTerminalYjsWsErrorCode(code, reason);
        if (terminalErrorCode) {
          setErrorCode(terminalErrorCode);
        } else {
          // 非终态断开（网络抖动/服务端重启）：客户端会自动重连（指数退避）。
          // 必须同步置 disconnected——若保持 connected，UI 显示已连接而 WS 实际
          // 断开，sendViaWs 会静默失败（消息无声消失）；disconnected 渲染分支
          // 由 autoReconnecting 标记展示"正在自动重连"轻提示。
          setAutoReconnecting(true);
          setConnectionState("disconnected");
        }
      },
      onConnectionState: (state: YjsWsState) => {
        if (state === "connecting") {
          setAutoReconnecting(false);
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
    // rcsSessionKey 变化触发重建（建连守卫，见上）；authState 变化驱动登录态守卫
  }, [
    agentId,
    sessionId,
    rcsSessionKey,
    authState,
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
      : undefined;

    return {
      supportsImages,
      modelName,
      supportsLoadSession: !!(caps?.loadSession || caps?.sessionCapabilities),
      availableCommands: chatState.availableCommands,
      availableModes: mds?.availableModes ?? [],
      currentModeId: mds?.currentModeId ?? null,
      supportsModeSelection: mds != null && (mds.availableModes?.length ?? 0) > 0,
      tokenUsage: chatState.tokenUsage,
    };
  }, [
    chatState.capabilities,
    chatState.modelState,
    chatState.modeState,
    chatState.availableCommands,
    chatState.tokenUsage,
  ]);

  // 为 ACPMain 提供的出站回调（经 sendAction 统一出口：WS 未就绪时 toast 反馈；
  // 回调保持 void 签名，与 ACPMainProps 契约一致，boolean 结果不外传）
  const callbacks = useMemo(
    () => ({
      onSendPrompt: (contentBlocks: unknown[]) => {
        // send_prompt 携带当前 ACP sessionId：服务端（translator → dispatcher）据此
        // 精确路由到对应 session。不带时 dispatcher fallback 连接级当前会话——多
        // 会话共享同一 relay 时该值可能已被其他会话改写，prompt 会落到错误会话
        // （当前 turn 永久 loading 的根因，修复：出站显式绑定目标 session）。
        sendAction({
          action: "send_prompt",
          content: contentBlocks,
          sessionId: sessionState.acpSessionId || undefined,
        });
      },
      // cancel 携带当前 ACP sessionId：服务端（translator → dispatcher）据此精确路由到
      // 对应 session 的活跃 query，多会话并发下避免取消落在错误的 query；空字符串
      // （会话未建立）时省略字段，服务端 fallback 当前会话（向后兼容旧客户端）。
      onCancel: () => {
        sendAction({ action: "cancel", sessionId: sessionState.acpSessionId || undefined });
      },
      onCreateSession: () => {
        sendAction({ action: "create_session" });
      },
      onLoadSession: (sid: string) => {
        sendAction({ action: "load_session", sessionId: sid });
      },
      onResumeSession: (sid: string) => {
        sendAction({ action: "resume_session", sessionId: sid });
      },
      onRenameSession: (sid: string, title: string) => {
        sendAction({ action: "rename_session", sessionId: sid, title });
      },
      onDeleteSession: (sid: string) => {
        sendAction({ action: "delete_session", sessionId: sid });
      },
      onRespondPermission: (requestId: string, optionId: string | null) => {
        sendAction({ action: "respond_permission", requestId, optionId });
      },
      onRespondQuestion: (questionId: string, optionIds: string[]) => {
        // AskUserQuestion 答案回传：多问题合并答案数组（按问题顺序），服务端 CAS
        // 迁移（仅 pending → resolved 一次）后以 control_response 帧发给 acp-link，
        // 组装 content[q_id]=label 注入 agent 继续执行
        sendAction({ action: "respond_question", questionId, optionIds });
      },
      onSetMode: (modeId: string) => {
        sendAction({ action: "set_session_mode", modeId });
      },
    }),
    [sendAction, sessionState.acpSessionId],
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
    // spawn_rejected 来自 WS close 4502（error 帧未先到时）；error 帧先到则为
    // auto_start_disabled/max_sessions_reached/launch_spec_build_failed 细分码
    const isSpawnRejected =
      isAutoStartDisabled || isMaxSessionsReached || isLaunchSpecBuildFailed || errorCode === "spawn_rejected";
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

  // 登录态未就绪（user session 加载中）——与"连接中"（WS 建连）语义分离，
  // 避免 auth 悬挂时 UI 永驻"正在连接 Agent"转圈
  if (authState === "loading") {
    return (
      <div className="agent-welcome-empty">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="title">{t("loadingUser")}</p>
      </div>
    );
  }

  // 登录态失败（useSession 报错 / 未登录）——明确错误态 + 重试出口
  if (authState === "failed") {
    return (
      <div className="agent-welcome-empty">
        <p className="title">{t("authFailed")}</p>
        <p className="desc">{t("authFailedDesc")}</p>
        <Button variant="outline" onClick={() => refetchSession()} className="mt-2">
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
        {/* Agent 运行时错误（后端 agent.publicError 脱敏投影）— 展示在会话顶部 */}
        {sessionState.agentPublicError?.message && (
          <div
            className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {sessionState.agentPublicError.message}
          </div>
        )}
        <ACPMain
          agentId={agentId}
          initialCwd={initialCwd}
          hideSidebar={hideSidebar}
          // 此处必须是 RCS session id（与 Y.Doc 命名一致），不是 URL sessionId：
          // URL sessionId 是实例会话标识（ses_inst_*），仅用于 WS 建连参数
          rcsSessionId={rcsSessionKey ?? undefined}
          detailSessionId={sessionId ?? undefined}
          scenePrompt={scenePrompt}
          contextKey={contextKey}
          onPromptComplete={onPromptComplete}
          chatState={chatState}
          sessionState={sessionState}
          connectionState={connectionState}
          // Peri Task 视图（切片 2）：会话活动面板数据，经 ACPMain 透传给 ChatInterface
          periTasks={periTaskState.tasks}
          periTasksLoaded={periTaskState.loaded}
          supportsImages={derivedState.supportsImages}
          supportsLoadSession={derivedState.supportsLoadSession}
          modelName={derivedState.modelName}
          tokenUsage={derivedState.tokenUsage}
          availableCommands={derivedState.availableCommands}
          availableModes={derivedState.availableModes}
          currentModeId={derivedState.currentModeId}
          supportsModeSelection={derivedState.supportsModeSelection}
          {...callbacks}
        />
      </TooltipProvider>
    );
  }

  // 断开（非错误，非连接中）。
  // 非终态断开（autoReconnecting）：客户端正在自动重连，展示轻提示而非整屏错误；
  // 终态断开（4001/4500 等）：自动重连已停止，必须手动点击重连。
  return (
    <div className="agent-welcome-empty">
      <p className="title">{autoReconnecting ? t("reconnecting") : t("agentDisconnected")}</p>
      <p className="desc">{autoReconnecting ? t("reconnectingDesc") : t("agentOfflineDesc")}</p>
      <Button variant="outline" onClick={handleReconnect} className="mt-2">
        <RefreshCw className="h-4 w-4" />
        {t("reconnect")}
      </Button>
    </div>
  );
}
