import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import type { ChatStateSnapshot } from "../../types";
import type { ChatInterfaceHandle } from "../ChatInterface";
import type { ChatNotice } from "../chat-interface-types";
import type { SessionSelectFallback } from "../sidebar-session-list";

interface UseAcpSessionBootstrapOptions {
  connectionState?: string;
  chatState?: ChatStateSnapshot;
  /** ChatInterface 句柄：切换会话前用它判断当前会话是否正在生成 */
  chatRef: RefObject<ChatInterfaceHandle | null>;
  supportsLoadSession: boolean;
  supportsResumeSession: boolean;
  onLoadSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
  onNotice?: (notice: ChatNotice) => void;
  /** 新会话创建（ACPMain 已做 Promise 适配的包装回调） */
  handleCreateSession: () => Promise<void> | void;
  /** 用户主动切换会话时的副作用（收起移动端抽屉）；自动恢复不触发 */
  onUserSessionSelected?: () => void;
}

/**
 * 会话引导与切换编排：300ms 防抖选最近会话、延迟到达的 activeSessionId 进入、切换失败的高亮回退。
 *
 * 从 `ACPMain.tsx` 拆出（§4.7 的三层拆分：编排 hook）。这一段是「何时进入哪个会话」的全部决策，
 * 与布局渲染无关；`ACPMain` 只消费它给出的 `initialActiveSessionId` / `sessionSelectFallback` /
 * `handleSelectSession`，不反向读它的内部状态。逻辑与注释逐字保留。
 */
export function useAcpSessionBootstrap({
  connectionState,
  chatState,
  chatRef,
  supportsLoadSession,
  supportsResumeSession,
  onLoadSession,
  onResumeSession,
  onNotice,
  handleCreateSession,
  onUserSessionSelected,
}: UseAcpSessionBootstrapOptions) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const sessions = chatState?.sessions ?? [];

  const [initialActiveSessionId, setInitialActiveSessionId] = useState<string | null>(null);
  // 会话切换失败的回退信号（见 `SessionSelectFallback`）：侧边栏高亮是点击时的乐观置位，
  // 失败后必须显式下发信号把它拉回真实会话，否则高亮与消息区长期不一致。
  const [sessionSelectFallback, setSessionSelectFallback] = useState<SessionSelectFallback | null>(null);

  // 已进入过某个 session 的标记（包括 bootstrap 自动选择和用户手动切换）
  // 用于防止重复进入 session 以及处理延迟到达的 activeSessionId
  const sessionEnteredRef = useRef(false);
  // 防抖：sessions 增量更新可能分多次到达（list_sessions 返回 N 条 registerSession 逐条广播），
  // 等待 300ms 稳定后再执行 bootstrap，避免在只收到第一条 session 时就过早加载
  const bootstrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 取消尚未触发的 bootstrap 防抖。
   *
   * 2026-09-22 库内去重：`connectionState` 重置 effect 与该 effect 的 cleanup 此前各写了一份
   * 逐字相同的 `if (bootstrapTimerRef.current) { clearTimeout(…); bootstrapTimerRef.current = null; }`，
   * 收敛到此（`useCallback([])`，只碰一个 ref，身份稳定）。
   */
  const clearBootstrapTimer = useCallback(() => {
    if (bootstrapTimerRef.current) {
      clearTimeout(bootstrapTimerRef.current);
      bootstrapTimerRef.current = null;
    }
  }, []);

  // 该 effect 的依赖是有意的：connectionState 仅作为"重连时重置 bootstrap 状态"的触发器，
  // 函数体不读取它（源 `ACPMain.tsx` 同款写法）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectionState 作为重连触发器参与依赖，非冗余依赖
  useEffect(() => {
    sessionEnteredRef.current = false;
    clearBootstrapTimer();
  }, [connectionState, clearBootstrapTimer]);

  // 切换失败后的高亮回退目标：取会话投影实际展示的会话（也是输入/prompt 路由的目标），
  // 保证「高亮 = 消息区」；宿主未注入 chatState 时退回本组件已跟踪的会话。
  const rollbackSessionHighlight = useCallback(() => {
    const currentSessionId = chatState?.activeSessionId ?? initialActiveSessionId ?? null;
    setSessionSelectFallback((prev) => ({ sessionId: currentSessionId, token: (prev?.token ?? 0) + 1 }));
  }, [chatState?.activeSessionId, initialActiveSessionId]);

  // Handle session selection. 刷新后的会话恢复必须继续加载正在进行的会话；
  // 仅用户主动切换时，才需要以 loading 保护当前对话不被切走。
  const handleSelectSession = useCallback(
    async (session: { sessionId: string }, source: "user" | "restore" = "user") => {
      if (source === "user" && chatRef.current?.isLoading) {
        onNotice?.({ level: "warning", message: t("chat.components.acpMain.chatBusy") });
        return;
      }
      // 引擎既无 loadSession 也无 resumeSession 时没有任何可执行的切换动作：必须给用户
      // 明确反馈并回退高亮，否则点击只留下控制台日志、界面停在错误的高亮上（静默失败）。
      // 该提示只在用户主动切换时下发——自动恢复（restore）失败在页面打开瞬间发生，
      // 弹提示属于噪声，其失败仍保留下方同一份 console.error 诊断。
      if (!supportsLoadSession && !supportsResumeSession) {
        console.error("Failed to load/resume session: Loading or resuming sessions is not supported by this agent.");
        if (source === "user") {
          onNotice?.({ level: "warning", message: t("chat.components.acpMain.sessionSwitchUnsupported") });
        }
        rollbackSessionHighlight();
        return;
      }
      try {
        if (supportsLoadSession) {
          onLoadSession(session.sessionId);
        } else {
          onResumeSession(session.sessionId);
        }
        sessionEnteredRef.current = true;
        setInitialActiveSessionId(session.sessionId);
        if (source === "user") onUserSessionSelected?.();
      } catch (error) {
        // 意外失败（宿主回调抛错等）：提示与诊断上下文一并保留，并回退乐观高亮。
        console.error("Failed to load/resume session:", error);
        if (source === "user") {
          onNotice?.({ level: "error", message: t("chat.components.acpMain.sessionSwitchFailed") });
        }
        rollbackSessionHighlight();
      }
    },
    [
      supportsLoadSession,
      supportsResumeSession,
      onLoadSession,
      onResumeSession,
      t,
      onNotice,
      rollbackSessionHighlight,
      onUserSessionSelected,
      chatRef,
    ],
  );

  // Bootstrap: 通过 YJS chatState 获取会话列表，自动进入最近会话。
  // 使用防抖避免增量更新分片到达时的过早触发（如 list_sessions 逐条 broadcast）。
  // 列表未确认（sessionListLoaded=false）时不自动创建新会话：连接建立瞬间
  // list_sessions 响应通常尚未到达（agent 初始化 + 列表查询约 1s），此时自动
  // create_session 会制造"假空"会话竞态（有历史会话却新建空会话，页面无数据）。
  // 等待列表到达后本 effect 因 sessions 变化重新触发并加载最新会话；列表确认
  // 为空（sessionListLoaded=true 且 sessions 空）时自动创建新会话，打开页面即
  // 可对话，无需用户手动输入第一条消息触发懒创建（见下方分支）。
  useEffect(() => {
    if (connectionState !== "connected") return;
    if (sessionEnteredRef.current) return;

    // 清除上一次的防抖定时器，重新计时
    if (bootstrapTimerRef.current) {
      clearTimeout(bootstrapTimerRef.current);
    }

    bootstrapTimerRef.current = setTimeout(() => {
      bootstrapTimerRef.current = null;
      if (sessionEnteredRef.current) return;

      // 如果 chatState 已有 activeSessionId，直接使用
      // 但仍需发送 load_session 初始化当前客户端的 Session Doc 同步，
      // 否则新客户端看不到已有消息（第二个客户端接入同一会话时会卡在加载状态）
      if (chatState?.activeSessionId) {
        setInitialActiveSessionId(chatState.activeSessionId);
        const activeSession = sessions.find((s) => s.sessionId === chatState.activeSessionId);
        if (activeSession) {
          sessionEnteredRef.current = true;
          handleSelectSession(activeSession, "restore");
        }
        return;
      }

      // 加载最新会话
      const latest = sessions.slice().sort((a, b) => {
        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return timeB - timeA;
      })[0];

      if (latest) {
        sessionEnteredRef.current = true;
        setInitialActiveSessionId(latest.sessionId);
        handleSelectSession(latest, "restore");
        return;
      }

      // 无历史会话：仅当列表已权威确认（sessionListLoaded）且确实为空时才自动创建
      // 新会话——列表未到达时的空列表不可信（有历史会话时误创建"假空"会话，
      // 页面无数据）；session_list 到达后本 effect 因 sessions 变化重新触发，
      // 确认空列表即自动进入可对话状态，用户无需手动输入第一条消息触发懒创建。
      if (chatState?.sessionListLoaded && sessions.length === 0) {
        sessionEnteredRef.current = true;
        void handleCreateSession();
        return;
      }
    }, 300);

    return () => {
      clearBootstrapTimer();
    };
  }, [
    connectionState,
    sessions,
    chatState?.activeSessionId,
    chatState?.sessionListLoaded,
    handleSelectSession,
    handleCreateSession,
    clearBootstrapTimer,
  ]);

  // 延迟 activeSessionId 处理：bootstrap 在 sessions 为空时不创建会话而是等待。
  // 当服务端 session_list 响应到达并设置 activeSessionId 后，
  // 需要首次进入该会话，避免前端停留在空状态。
  useEffect(() => {
    // 连接守卫：断线/重连期间服务端 activeSessionId 可能残留旧值，不得据其进入
    // 会话（与 bootstrap effect 共享同一守卫，避免两处条件不一致）
    if (connectionState !== "connected") return;
    const sid = chatState?.activeSessionId;
    if (!sid || sessionEnteredRef.current) return;
    // 确认 sessions 中包含该 activeSessionId 对应的会话
    const activeSession = sessions.find((s) => s.sessionId === sid);
    if (!activeSession) return;

    sessionEnteredRef.current = true;
    setInitialActiveSessionId(sid);
    try {
      handleSelectSession(activeSession, "restore");
    } catch (err) {
      console.error("[ACPMain] Delayed session enter failed:", err);
    }
  }, [chatState?.activeSessionId, sessions, connectionState, handleSelectSession]);

  return {
    sessions,
    initialActiveSessionId,
    setInitialActiveSessionId,
    sessionSelectFallback,
    handleSelectSession,
  };
}
