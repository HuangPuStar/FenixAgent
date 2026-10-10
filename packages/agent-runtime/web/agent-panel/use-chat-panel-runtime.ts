// use-chat-panel-runtime.ts
// ChatPanel 的运行时：YJS 建连/重连状态机、commandId 幂等缓存、出站 Action 回调与 ACP 展示态派生。
//
// 拆分背景（CE 阶段 2 §1.6 T6d）：ChatPanel 原是单文件 494 行，transport/状态机与分支渲染混在一起，
// 按职责拆三份（各 ≤500 行）：
// - 本文件：连接与动作（无 JSX）
// - `ChatPanel.tsx`：分支渲染与错误卡片（不含状态机）
// - `chat-panel-ports.tsx`：ui-components 面板的端口装配
//
// 归属（台账 `ce-standards-todo.md` D1）：连接状态机是 chat 域实现，随聊天容器簇归位本包。此前它因
// `useSession`（`@fenix/identity/web`，platform-impl）与 `useTaskViews`（`@fenix/resource-task`，资源包）
// 留在宿主；现在两项改由宿主经 `ChatPanelHostPorts` 注入（见 `chat-panel-host-ports.ts` 的边界说明），
// 本文件不再持有任何跨域依赖。
//
// 包内依赖走相对路径而不是包根入口：`src/index.ts` 与 `web/index.ts` 是**对外**出口，包内反向引用会形成
// 入口自环（`.dependency-cruiser.cjs` 的 `no-circular`），也让「谁依赖谁」在包内看不见。
// 建连时机 `chat-auth-state` 与可见性重连 `chat-visible-reconnect` 位于兄弟目录 `web/hooks/`。

import {
  type ActionAck,
  type ActionError,
  createDeterministicRcsSessionId,
  type PublicErrorInfo,
  type TerminalWsUiCode,
} from "@fenix/chat-channel";
import { useChatPageVisible } from "@fenix/web-runtime/hooks/use-page-visible";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ChatAuthState } from "../hooks/chat-auth-state";
import type { ChatWsConnectionState } from "../hooks/chat-visible-reconnect";
import { useChatState } from "../hooks/use-chat-state";
import { useSessionState } from "../hooks/use-session-state";
import { AGENT_CHAT_NS } from "../i18n/namespace";
import { randomUUID } from "../lib/random-uuid";
import { applyDocHubUpdate, getDocHubStateVectors, replaceDocHubUpdate } from "../yjs/doc-hub";
import { buildYjsUrl, createYjsWs, resolveYjsWsCloseOutcome, type YjsWsState } from "../yjs/yjs-ws";
import type { PeriTaskViewsResult, UsePeriTaskViews } from "./chat-panel-host-ports";

/** `ACPMain` 的出站回调集合（`sessionState.acpSessionId` 变化时重建，见下）。 */
export interface ChatPanelCallbacks {
  onSendPrompt: (contentBlocks: unknown[]) => void;
  onCancel: () => void;
  onCreateSession: () => void;
  onLoadSession: (sid: string) => void;
  onResumeSession: (sid: string) => void;
  onRenameSession: (sid: string, title: string) => void;
  onDeleteSession: (sid: string) => void;
  onRespondPermission: (requestId: string, optionId: string | null) => void;
  onRespondQuestion: (questionId: string, answers: Array<string | string[]>) => void;
  onSetMode: (modeId: string) => void;
}

/** `ACPMain` 需要的派生展示态（从 Chat Doc 的能力/模型/模式子树投影）。 */
export interface ChatPanelDerivedState {
  supportsImages: boolean;
  modelName: string | undefined;
  supportsLoadSession: boolean;
  availableCommands: ReturnType<typeof useChatState>["state"]["availableCommands"];
  availableModes: { id: string; name: string }[];
  currentModeId: string | null;
  supportsModeSelection: boolean;
  tokenUsage: ReturnType<typeof useChatState>["state"]["tokenUsage"];
}

/**
 * ChatPanel 的运行时状态与出站出口。
 *
 * `chatState` / `sessionState` 是两份 Y.Doc 的读数（DocHub 共享实例），`periTasks` 单独订阅
 * Session Doc 的 tasks 子树；三者由本 hook 统一持有，渲染层只做分支。
 */
export interface ChatPanelRuntime {
  authState: ChatAuthState;
  connectionState: ChatWsConnectionState;
  /** 最近一次服务端分类错误；责任域由错误产生边界提供，不能按 WebSocket 通道猜测。 */
  classifiedError: PublicErrorInfo | null;
  /** 最近一次 action_error（transient banner）；不进入 connectionState 状态机。 */
  actionError: ActionError | null;
  /** 非终态断开后的自动重连标记：UI 展示轻提示而非整屏「已断开」。 */
  autoReconnecting: boolean;
  /**
   * 最近一次终态关闭的 UI 语义码（策略表的 `uiCode`），非终态断开或新连接开始时为 null。
   *
   * 为什么单列一项而不是复用 `classifiedError`：`uiCode` 描述的是**连接为什么结束**（用户主动停止、
   * 实例被回收…），与「服务端发过哪个公开错误」是两回事——4001/4002 这类关闭不带 error 帧，
   * 事件到达时也不产生错误对象。渲染层据此区分「预期内终态」与「故障」（见 ChatPanel 分支）。
   */
  terminalUiCode: TerminalWsUiCode | null;
  /** RCS session id（Y.Doc 命名用），未就绪时为 undefined。 */
  rcsSessionKey: string | undefined;
  chatState: ReturnType<typeof useChatState>["state"];
  sessionState: ReturnType<typeof useSessionState>["state"];
  periTasks: PeriTaskViewsResult["state"]["tasks"];
  periTasksLoaded: boolean;
  derivedState: ChatPanelDerivedState;
  callbacks: ChatPanelCallbacks;
}

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
  const { t } = useTranslation(AGENT_CHAT_NS);
  const [connectionState, setConnectionState] = useState<ChatWsConnectionState>("disconnected");
  const [classifiedError, setClassifiedError] = useState<PublicErrorInfo | null>(null);
  // 最近一次 action_error（transient banner，5s 自动清除）；不进入 errorCode 连接状态机，
  // 避免单动作失败触发整屏错误态
  const [actionError, setActionError] = useState<ActionError | null>(null);
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

  /** 保存服务端 Action 公开错误；不按重试语义分支或自动清除诊断标识。 */
  const showActionError = useCallback((err: ActionError) => setActionError(err), []);

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

  // Chat Doc — 观察全局 Chat 状态（连接、Agent 信息、会话列表、权限）
  const { state: chatState } = useChatState(docHubKey);

  // Session Doc — 按 RCS session ID 命名（与 chatHook 同一 hub entry，共享 doc 副本）
  const { state: sessionState } = useSessionState(docHubKey);

  // ACP session 是连接建立后的可变会话元数据，不属于 YJS transport identity。
  // 仅在真正重建连接时读取最新值用于刷新恢复；后续 session/load 更新不得触发断连。
  const acpSessionIdRef = useRef(sessionState.acpSessionId);
  acpSessionIdRef.current = sessionState.acpSessionId;

  // Peri Task 视图 — 只订阅 Session Doc 的 tasks/taskOrder 子树（DocHub 共享实例，
  // 与上面两个 hook 同一份 doc；Chat Doc token 流不触发本 selector 重算）。
  // 订阅能力由宿主注入（投影 owner 是资源包），调用方式与包内 hook 一致：顶层、无条件、传本包派生的 key。
  const { state: periTaskState } = usePeriTaskViews(docHubKey);

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
  // 返回是否真正发出：WS 未就绪/已断开、或发送被背压拒绝时返回 false（不静默丢弃——静默失败是
  // "消息无声消失"的根因），由调用方给出 UI 反馈。
  const sendViaWs = useCallback(
    (data: Record<string, unknown>): boolean => {
      const ws = yjsWsRef.current;
      if (!ws?.isConnected()) return false;
      const key = commandKey(data);
      // 后台刷新显式携带独立 commandId，避免连续 mutation 的 list_sessions
      // 在前一个 Ack 到达前复用幂等键而被服务端去重。
      const explicitCommandId = typeof data.commandId === "string" ? data.commandId : null;
      const commandId = explicitCommandId ?? commandIdCacheRef.current.get(key) ?? randomUUID();
      if (!explicitCommandId) commandIdCacheRef.current.set(key, commandId);
      // transport 的 send 返回是否真正写入 socket（含 64 KB 发送背压判定，见
      // packages/chat-channel/src/transport/ws.ts）；未写成功时缓存里的 commandId 保留，
      // 同一动作重试会复用同一幂等键——与 request() 的 opId 重试口径一致（§5.2）。
      return ws.send({ ...data, commandId });
    },
    [commandKey],
  );

  // 发送动作统一入口：失败（WS 未就绪 / 发送被背压拒绝）时 toast 反馈，避免用户输入无声丢失
  const sendAction = useCallback(
    (data: Record<string, unknown>): boolean => {
      const ok = sendViaWs(data);
      if (!ok) toast.error(t("wsSendFailed"));
      return ok;
    },
    [sendViaWs, t],
  );

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
      onYjsUpdate: (docName, data) => {
        try {
          applyDocHubUpdate(rcsSessionKey, docName, data);
        } catch (err) {
          console.warn("[Yjs] Failed to apply update:", err);
        }
      },
      onYjsReplace: (docName, generation, data) => {
        replaceDocHubUpdate(rcsSessionKey, docName, generation, data);
      },
      getYjsStateVectors: () => getDocHubStateVectors(rcsSessionKey),
      onError: (error) => setClassifiedError(error),
      onClose: (close) => {
        // 关闭码语义取自策略表（`resolveYjsWsCloseOutcome`，同一份知识，见 yjs-ws.ts）：
        // 终态码（4001 实例回收 / 4002 用户主动停止 / 4004 / 4500 / 4501 / 4502）客户端不会再自动重连，
        // 此时 autoReconnecting 必须为 false——否则 UI 谎报「正在自动重连」，而实际在等用户手动恢复。
        const outcome = resolveYjsWsCloseOutcome(close.code, close.reason);
        setAutoReconnecting(!outcome.terminal);
        // 终态码的 UI 语义留给渲染层；非终态断开（网络抖动/服务端重启）置空，避免上一次的语义残留。
        setTerminalUiCode(outcome.uiCode);
        // 非终态断开必须同步置 disconnected——若保持 connected，UI 显示已连接而 WS 实际
        // 断开，sendViaWs 会静默失败（消息无声消失）；disconnected 渲染分支
        // 由 autoReconnecting 标记展示"正在自动重连"轻提示。
        setConnectionState("disconnected");
      },
      onConnectionState: (state: YjsWsState) => {
        if (state === "connecting") {
          setAutoReconnecting(false);
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
  }, [agentId, sessionId, rcsSessionKey, authState, sendViaWs, handleActionAck, releaseCommandId, showActionError]);

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
    (): ChatPanelCallbacks => ({
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
      onRespondQuestion: (questionId: string, answers: Array<string | string[]>) => {
        // AskUserQuestion 答案按问题顺序回传；单选为 string，多选保留 string[]。
        // 服务端 CAS 迁移后以 control_response 帧发给 acp-link，按 q_id 注入 agent。
        sendAction({ action: "respond_question", questionId, answers });
      },
      onSetMode: (modeId: string) => {
        sendAction({ action: "set_session_mode", modeId });
      },
    }),
    [sendAction, sessionState.acpSessionId],
  );

  return {
    authState,
    connectionState,
    classifiedError,
    actionError,
    autoReconnecting,
    terminalUiCode,
    rcsSessionKey,
    chatState,
    sessionState,
    periTasks: periTaskState.tasks,
    periTasksLoaded: periTaskState.loaded,
    derivedState,
    callbacks,
  };
}
