import type {
  AvailableCommand,
  ChatStateSnapshot,
  ContentBlock,
  PeriTaskViewProjection,
  SessionMode,
  SessionStateSnapshot,
} from "@fenix/chat-channel";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChatInterface, type ChatInterfaceHandle } from "./ChatInterface";
import { ChatHeader } from "./chat/ChatHeader";
import { SidebarSessionList } from "./chat/sidebar-session-list";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

interface ACPMainProps {
  agentId?: string;
  initialCwd?: string;
  readonly?: boolean;
  hideSidebar?: boolean;
  rcsSessionId?: string;
  /** 服务端确定性计算 rcsSessionId 使用的实例会话标识 */
  detailSessionId?: string;
  scenePrompt?: string;
  contextKey?: string;
  onPromptComplete?: () => void;
  chatState?: ChatStateSnapshot;
  sessionState?: SessionStateSnapshot | null;
  connectionState?: string;

  // ── 出站操作回调（替代 client 方法）──
  onSendPrompt: (contentBlocks: ContentBlock[]) => Promise<void> | void;
  onCancel: () => void;
  onCreateSession: () => Promise<void> | void;
  onLoadSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRespondPermission: (requestId: string, optionId: string | null) => void;
  /** AskUserQuestion 选项回传（questionId + 选中选项 label 数组，按问题顺序） */
  onRespondQuestion: (questionId: string, optionIds: string[]) => void;

  // ── 状态 props（替代 client.state / client.xxx 读取）──
  supportsImages?: boolean;
  supportsLoadSession?: boolean;
  supportsResumeSession?: boolean;
  availableCommands?: AvailableCommand[];
  availableModes?: SessionMode[];
  currentModeId?: string | null;
  onSetMode?: (modeId: string) => void;
  supportsModeSelection?: boolean;
  modelName?: string;
  tokenUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null;

  // ── Peri Task 视图（切片 2，会话活动面板）──
  /** Session Doc tasks/taskOrder 派生任务视图（非终态在前排序，引用稳定） */
  periTasks?: readonly PeriTaskViewProjection[];
  /** tasks/taskOrder 子树是否已同步（未同步时任务面板显示加载态） */
  periTasksLoaded?: boolean;
}

/**
 * Main container — Anthropic sidebar + chat layout.
 * Sidebar: sectioned by recency, orange active state, warm raised bg.
 */
export function ACPMain({
  agentId,
  readonly,
  hideSidebar,
  rcsSessionId,
  detailSessionId,
  scenePrompt,
  contextKey,
  onPromptComplete,
  chatState,
  sessionState,
  connectionState,
  onSendPrompt,
  onCancel,
  onCreateSession,
  onLoadSession,
  onResumeSession,
  onRenameSession,
  onDeleteSession,
  onRespondPermission,
  onRespondQuestion,
  supportsImages = false,
  supportsLoadSession = false,
  supportsResumeSession = false,
  availableCommands = [],
  availableModes = [],
  currentModeId = null,
  onSetMode = () => {},
  supportsModeSelection = false,
  modelName,
  tokenUsage,
  periTasks = [],
  periTasksLoaded = false,
}: ACPMainProps) {
  const { t } = useTranslation("components");
  const sessions = chatState?.sessions ?? [];
  // 从 localStorage 读取侧边栏状态，默认打开
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const saved = localStorage.getItem("acp-sidebar-open");
      // 首次访问（localStorage 无记录）→ 默认打开；用户手动收起后 → 记住选择
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [initialActiveSessionId, setInitialActiveSessionId] = useState<string | null>(null);
  const chatRef = useRef<ChatInterfaceHandle>(null);
  // 已进入过某个 session 的标记（包括 bootstrap 自动选择和用户手动切换）
  // 用于防止重复进入 session 以及处理延迟到达的 activeSessionId
  const sessionEnteredRef = useRef(false);
  // 防抖：sessions 增量更新可能分多次到达（list_sessions 返回 N 条 registerSession 逐条广播），
  // 等待 300ms 稳定后再执行 bootstrap，避免在只收到第一条 session 时就过早加载
  const bootstrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 连接重建时需重置 bootstrap 状态
  useEffect(() => {
    sessionEnteredRef.current = false;
    if (bootstrapTimerRef.current) {
      clearTimeout(bootstrapTimerRef.current);
      bootstrapTimerRef.current = null;
    }
  }, [connectionState]);

  // 保存侧边栏状态到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem("acp-sidebar-open", String(sidebarOpen));
    } catch {
      // localStorage 不可用时静默失败
    }
  }, [sidebarOpen]);

  // ── 提升的状态（从 props 获取，原 useCommands/useModes 已移除）──

  // ── Callbacks（直接调用 props 回调）──
  const handleSendPrompt = useCallback(
    async (contentBlocks: ContentBlock[]) => {
      const result = onSendPrompt(contentBlocks);
      if (result instanceof Promise) await result;
    },
    [onSendPrompt],
  );

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const handleCreateSession = useCallback(async () => {
    const result = onCreateSession();
    if (result instanceof Promise) await result;
  }, [onCreateSession]);

  const handleRespondPermission = useCallback(
    (requestId: string, optionId: string | null) => {
      onRespondPermission(requestId, optionId);
    },
    [onRespondPermission],
  );

  // Handle session selection. 刷新后的会话恢复必须继续加载正在进行的会话；
  // 仅用户主动切换时，才需要以 loading 保护当前对话不被切走。
  const handleSelectSession = useCallback(
    async (session: { sessionId: string }, source: "user" | "restore" = "user") => {
      if (source === "user" && chatRef.current?.isLoading) {
        toast.warning(t("acpMain.chatBusy"));
        return;
      }
      try {
        if (supportsLoadSession) {
          onLoadSession(session.sessionId);
        } else if (supportsResumeSession) {
          onResumeSession(session.sessionId);
        } else {
          throw new Error("Loading or resuming sessions is not supported by this agent.");
        }
        sessionEnteredRef.current = true;
        setInitialActiveSessionId(session.sessionId);
      } catch (error) {
        console.error("Failed to load/resume session:", error);
      }
    },
    [supportsLoadSession, supportsResumeSession, onLoadSession, onResumeSession, t],
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
      if (bootstrapTimerRef.current) {
        clearTimeout(bootstrapTimerRef.current);
        bootstrapTimerRef.current = null;
      }
    };
  }, [
    connectionState,
    sessions,
    chatState?.activeSessionId,
    chatState?.sessionListLoaded,
    handleSelectSession,
    handleCreateSession,
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

  return (
    // root 加 p-3 gap-3：让顶部 ChatHeader 浮动卡片与下方内容统一外边距，
    // 形成上下两个玻璃磨砂卡片悬浮在子页面背景上的视觉效果。
    // acp-main-root：作为窄屏容器（如 MetaAgentPanel）收紧 padding 的 CSS 作用域钩子
    <div className="acp-main-root flex h-full w-full flex-col">
      {/* 顶部 ChatHeader — 仅展示当前会话标题；会话列表统一从侧边栏进入 */}
      {/* readonly 时整体隐藏 */}
      {!readonly && (
        <ChatHeader
          activeSessionId={initialActiveSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={() => chatRef.current?.newSession()}
          onToggleSidebar={!hideSidebar ? () => setSidebarOpen((v) => !v) : undefined}
          sidebarOpen={sidebarOpen}
          sessions={sessions}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          showSessionList={false}
        />
      )}

      {/* 主体：横向 sidebar + chat */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧 sidebar — 仅在 sidebarOpen 且非 readonly/hideSidebar 时渲染，关闭时完全不占位 */}
        {!readonly && !hideSidebar && sidebarOpen && (
          <div className="chat-session-sidebar hidden md:flex flex-col transition-all duration-200 flex-shrink-0">
            {/* 头部：标题 + 新会话按钮 */}
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-xs font-display font-semibold text-text-muted uppercase tracking-widest px-1">
                {t("acpMain.sessions")}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => chatRef.current?.newSession()}
                  className="h-7 w-7 text-text-muted hover:text-brand hover:bg-brand/10"
                  title={t("acpMain.newSession")}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* 会话列表 */}
            <ScrollArea className="flex-1">
              <SidebarSessionList
                initialActiveSessionId={initialActiveSessionId}
                onSelectSession={handleSelectSession}
                sessions={sessions}
                onRenameSession={onRenameSession}
                onDeleteSession={onDeleteSession}
              />
            </ScrollArea>
          </div>
        )}

        {/* 聊天区域 */}
        <div className="chat-main-column flex-1 flex flex-col min-w-0">
          <ChatInterface
            ref={chatRef}
            agentId={agentId}
            readonly={readonly}
            hideContextPanel={true}
            rcsSessionId={rcsSessionId}
            detailSessionId={detailSessionId}
            scenePrompt={scenePrompt}
            contextKey={contextKey}
            onSessionCreated={(sessionId) => setInitialActiveSessionId(sessionId)}
            onPromptComplete={onPromptComplete}
            sessionState={sessionState}
            chatState={chatState}
            onSendPrompt={handleSendPrompt}
            onCancel={handleCancel}
            onCreateSession={handleCreateSession}
            onRespondPermission={handleRespondPermission}
            onRespondQuestion={onRespondQuestion}
            availableCommands={availableCommands}
            availableModes={availableModes}
            currentModeId={currentModeId}
            onSetMode={onSetMode}
            supportsModeSelection={supportsModeSelection}
            supportsImages={supportsImages}
            modelName={modelName}
            tokenUsage={tokenUsage}
            connectionState={connectionState}
            periTasks={periTasks}
            periTasksLoaded={periTasksLoaded}
          />
        </div>
      </div>
    </div>
  );
}
