import type { ChatStateSnapshot, SessionStateSnapshot } from "@fenix/acp-server";
import { MessageSquare, PanelRight, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";
import type { AgentSessionInfo, AvailableCommand, ContentBlock, SessionMode } from "../src/acp/types";
import { stripHtmlTags } from "../src/lib/strip-html-tags";
import { cn } from "../src/lib/utils";
import { ChatInterface, type ChatInterfaceHandle } from "./ChatInterface";
import { groupByRecency } from "./chat/session-grouping";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ACPMainProps {
  agentId?: string;
  initialCwd?: string;
  readonly?: boolean;
  hideSidebar?: boolean;
  rcsSessionId?: string;
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
  onListSessions: () => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRespondPermission: (requestId: string, optionId: string | null) => void;

  // ── 状态 props（替代 client.state / client.xxx 读取）──
  supportsImages?: boolean;
  supportsLoadSession?: boolean;
  supportsResumeSession?: boolean;
  /** @deprecated 通过 chatState.sessions 获取会话列表，此参数可移除 */
  _supportsSessionList?: boolean;
  availableCommands?: AvailableCommand[];
  availableModes?: SessionMode[];
  currentModeId?: string | null;
  onSetMode?: (modeId: string) => void;
  supportsModeSelection?: boolean;
  modelName?: string;
  tokenUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null;
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
  onListSessions: _onListSessions,
  onRenameSession,
  onDeleteSession,
  onRespondPermission,
  supportsImages = false,
  supportsLoadSession = false,
  supportsResumeSession = false,
  /** @deprecated 通过 chatState.sessions 获取会话列表，此参数可移除 */
  _supportsSessionList = true,
  availableCommands = [],
  availableModes = [],
  currentModeId = null,
  onSetMode = () => {},
  supportsModeSelection = false,
  modelName,
  tokenUsage,
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
  const sidebarPanelRef = usePanelRef();
  const [sidebarDefaultSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("acp-sidebar-size"));
      return Number.isFinite(saved) && saved >= 18 && saved <= 40 ? saved : 25;
    } catch {
      return 25;
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
  // 防止空会话时重复发送 create_session
  const autoCreateTriggeredRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 连接重建时需重置 bootstrap 状态
  useEffect(() => {
    sessionEnteredRef.current = false;
    autoCreateTriggeredRef.current = false;
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

  // 保持面板的 imperative 状态与 localStorage 中的展开状态同步。
  useEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (sidebarOpen && panel.isCollapsed()) panel.expand();
    if (!sidebarOpen && !panel.isCollapsed()) panel.collapse();
  }, [sidebarOpen, sidebarPanelRef]);

  const handleSidebarResize = useCallback(
    (panelSize: { asPercentage: number }) => {
      const collapsed = sidebarPanelRef.current?.isCollapsed() ?? !sidebarOpen;
      setSidebarOpen((open) => (open === !collapsed ? open : !collapsed));
      if (!collapsed && Number.isFinite(panelSize.asPercentage)) {
        try {
          localStorage.setItem("acp-sidebar-size", String(panelSize.asPercentage));
        } catch {
          // localStorage 不可用时仅保留当前会话内的尺寸。
        }
      }
    },
    [sidebarOpen, sidebarPanelRef],
  );

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

  // Handle session selection
  const handleSelectSession = useCallback(
    async (session: AgentSessionInfo) => {
      if (chatRef.current?.isLoading) {
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
  // 会话为空时不自动创建新会话，等待后端 session_list 设置 activeSessionId。
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
          handleSelectSession(activeSession as AgentSessionInfo);
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
        handleSelectSession(latest as AgentSessionInfo);
        return;
      }

      // 无历史会话 → 自动创建新会话，让前端直接进入可输入状态
      if (!autoCreateTriggeredRef.current) {
        autoCreateTriggeredRef.current = true;
        handleCreateSession();
      }
    }, 300);

    return () => {
      if (bootstrapTimerRef.current) {
        clearTimeout(bootstrapTimerRef.current);
        bootstrapTimerRef.current = null;
      }
    };
  }, [connectionState, sessions, chatState?.activeSessionId, handleSelectSession, handleCreateSession]);

  // 延迟 activeSessionId 处理：bootstrap 在 sessions 为空时不创建会话而是等待。
  // 当服务端 session_list 响应到达并设置 activeSessionId 后，
  // 需要首次进入该会话，避免前端停留在空状态。
  useEffect(() => {
    const sid = chatState?.activeSessionId;
    if (!sid || sessionEnteredRef.current) return;
    // 确认 sessions 中包含该 activeSessionId 对应的会话
    const activeSession = sessions.find((s) => s.sessionId === sid);
    if (!activeSession) return;

    sessionEnteredRef.current = true;
    setInitialActiveSessionId(sid);
    try {
      handleSelectSession(activeSession as AgentSessionInfo);
    } catch (err) {
      console.error("[ACPMain] Delayed session enter failed:", err);
    }
  }, [chatState?.activeSessionId, sessions, handleSelectSession]);

  const chatContent = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <ChatInterface
        ref={chatRef}
        agentId={agentId}
        readonly={readonly}
        hideContextPanel={true}
        rcsSessionId={rcsSessionId}
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
        availableCommands={availableCommands}
        availableModes={availableModes}
        currentModeId={currentModeId}
        onSetMode={onSetMode}
        supportsModeSelection={supportsModeSelection}
        supportsImages={supportsImages}
        modelName={modelName}
        tokenUsage={tokenUsage}
      />
    </div>
  );

  return (
    <div className="acp-main-root flex h-full w-full flex-col gap-3 p-3">
      {!readonly && !hideSidebar ? (
        <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0 min-w-0">
          <ResizablePanel
            panelRef={sidebarPanelRef}
            defaultSize={`${sidebarDefaultSize}%`}
            minSize="18%"
            maxSize="40%"
            collapsible
            collapsedSize="0%"
            onResize={handleSidebarResize}
          >
            <SessionSidebar
              sessions={sessions}
              initialActiveSessionId={initialActiveSessionId}
              onSelectSession={handleSelectSession}
              onNewSession={() => chatRef.current?.newSession()}
              onRenameSession={onRenameSession}
              onDeleteSession={onDeleteSession}
            />
          </ResizablePanel>
          <ResizableHandle>
            <button
              type="button"
              className={cn("agent-artifacts-expand-btn", !sidebarOpen && "open")}
              onClick={() => setSidebarOpen((open) => !open)}
              title={sidebarOpen ? t("acpMain.closeToPopover") : t("acpMain.sessions")}
              aria-label={sidebarOpen ? t("acpMain.closeToPopover") : t("acpMain.sessions")}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
          </ResizableHandle>
          <ResizablePanel defaultSize={`${100 - sidebarDefaultSize}%`} minSize="30%">
            {chatContent}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        chatContent
      )}
    </div>
  );
}

// =============================================================================
// 侧边栏会话列表 — Anthropic 分段式（今天/昨天/更早）
// =============================================================================

interface SessionSidebarProps {
  sessions: readonly { sessionId: string; title?: string | null; updatedAt?: string | null }[];
  initialActiveSessionId: string | null;
  onSelectSession: (session: AgentSessionInfo) => void;
  onNewSession: () => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
}

/** 会话侧栏：固定顶部搜索/新建，下面承载可滚动的历史会话列表。 */
function SessionSidebar({
  sessions,
  initialActiveSessionId,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
}: SessionSidebarProps) {
  const { t } = useTranslation("components");
  const [searchQuery, setSearchQuery] = useState("");
  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter(
      (session) =>
        stripHtmlTags(session.title?.toLowerCase() ?? "").includes(query) ||
        session.sessionId.toLowerCase().includes(query),
    );
  }, [searchQuery, sessions]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl bg-surface-1"
      style={{ boxShadow: "var(--shadow-card)" }}
    >
      <div className="flex h-11 flex-shrink-0 items-center gap-1.5 border-b border-border/40 p-2">
        <Search className="ml-1 h-3.5 w-3.5 flex-shrink-0 text-text-muted" />
        <Input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t("chatHeader.searchPlaceholder")}
          className="h-7 border-0 px-1 text-xs shadow-none focus-visible:ring-0"
          aria-label={t("chatHeader.searchPlaceholder")}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={onNewSession}
          className="h-7 w-7 flex-shrink-0 text-text-muted hover:bg-brand/10 hover:text-brand"
          title={t("acpMain.newSession")}
          aria-label={t("acpMain.newSession")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <SidebarSessionList
          initialActiveSessionId={initialActiveSessionId}
          onSelectSession={onSelectSession}
          sessions={filteredSessions}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
        />
      </ScrollArea>
    </div>
  );
}

function SidebarSessionList({
  initialActiveSessionId,
  onSelectSession,
  sessions = [],
  loading = false,
  onRenameSession,
  onDeleteSession,
}: {
  initialActiveSessionId: string | null;
  onSelectSession: (session: AgentSessionInfo) => void;
  sessions?: readonly { sessionId: string; title?: string | null; updatedAt?: string | null }[];
  loading?: boolean;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation("components");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  // 重命名处理
  const handleStartRename = (session: AgentSessionInfo) => {
    setEditingId(session.sessionId);
    setEditTitle(session.title ?? "");
  };
  const handleSaveRename = useCallback(
    async (sessionId: string) => {
      const title = editTitle.trim();
      if (!title) return;
      try {
        onRenameSession(sessionId, title);
      } catch (err) {
        toast.error(`重命名失败: ${(err as Error).message}`);
      }
      setEditingId(null);
      setEditTitle("");
    },
    [editTitle, onRenameSession],
  );
  const handleCancelRename = () => {
    setEditingId(null);
    setEditTitle("");
  };

  // 删除处理
  const handleDelete = useCallback(
    async (sessionId: string) => {
      try {
        onDeleteSession(sessionId);
        if (activeId === sessionId) {
          setActiveId(null);
        }
      } catch (err) {
        toast.error(`删除失败: ${(err as Error).message}`);
      }
    },
    [onDeleteSession, activeId],
  );

  useEffect(() => {
    if (initialActiveSessionId) {
      setActiveId(initialActiveSessionId);
    }
  }, [initialActiveSessionId]);

  const sorted = useMemo(
    () =>
      sessions.slice().sort((a, b) => {
        const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return dateB - dateA;
      }),
    [sessions],
  );

  if (loading && sessions.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-5 w-5 rounded-full border-2 border-brand border-t-transparent animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-1">
        <span className="text-xs text-text-muted font-display">{t("acpMain.noSessions")}</span>
        <span className="text-[10px] text-text-muted">{t("acpMain.clickToCreate")}</span>
      </div>
    );
  }

  // 按日期分组（groupByRecency 内部已做 updatedAt 降序排序，sorted 变量保留供后续扩展使用）
  const groups = groupByRecency(sorted, {
    today: t("acpMain.today"),
    yesterday: t("acpMain.yesterday"),
    earlier: t("acpMain.earlier"),
  });

  return (
    <nav className="py-1" aria-label={t("acpMain.historySessions")}>
      {groups.map((group, gi) => (
        <div key={group.label}>
          {gi > 0 && <div className="mx-3 my-2 border-t border-border/40" />}
          <div className="px-4 py-2">
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-text-muted/70">
              {group.label}
            </span>
          </div>
          {group.sessions.map((session) => {
            const isEditing = editingId === session.sessionId;
            return (
              <div key={session.sessionId} className="group relative">
                {isEditing ? (
                  <div className="flex items-center gap-1 px-4 py-1.5">
                    <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
                    <input
                      className="flex-1 text-[13px] font-display bg-transparent border-b border-brand text-text-primary outline-none px-1 py-0.5"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveRename(session.sessionId);
                        if (e.key === "Escape") handleCancelRename();
                      }}
                      onBlur={() => handleSaveRename(session.sessionId)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-text-muted hover:text-text-primary"
                      onClick={handleCancelRename}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <div
                    className={cn(
                      "flex items-center",
                      session.sessionId === activeId ? "bg-brand/8" : "hover:bg-surface-2/60",
                    )}
                  >
                    <SessionTitleButton
                      session={session}
                      isActive={session.sessionId === activeId}
                      onSelect={() => {
                        setActiveId(session.sessionId);
                        onSelectSession(session as AgentSessionInfo);
                      }}
                    />
                    {/* 悬停时显示操作按钮 */}
                    <div className="flex w-14 flex-shrink-0 items-center gap-0.5 pr-1 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled
                            className="h-6 w-6 p-0 text-text-muted hover:text-brand"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartRename(session as AgentSessionInfo);
                            }}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("acpMain.rename")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled
                            className="h-6 w-6 p-0 text-text-muted hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(session.sessionId);
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("acpMain.delete")}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

interface SessionTitleButtonProps {
  session: { sessionId: string; title?: string | null };
  isActive: boolean;
  onSelect: () => void;
}

/**
 * SessionTitleButton —— 侧边栏会话列表中的单个会话标题按钮。
 *
 * 会话标题可能因宽度不足被 truncate 截断，故 hover 时统一弹出主题化 tooltip 展示完整标题。
 * 整体 ACPMain 已被 ChatPanel 的 TooltipProvider 包裹，此处直接使用 Tooltip 即可，无需再引入 provider。
 */
function SessionTitleButton({ session, isActive, onSelect }: SessionTitleButtonProps) {
  const { t } = useTranslation("components");
  // 标题清洗：剔除混入的 HTML 标签（如 <system-reminder>），清洗后为空则回退到"新会话"占位
  const displayTitle = stripHtmlTags(session.title?.trim() || "") || t("acpMain.newSession");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          onClick={onSelect}
          className={cn(
            "flex-1 flex items-center gap-2.5 px-4 py-2 text-left justify-start rounded-none min-w-0",
            isActive
              ? "text-text-primary hover:bg-transparent"
              : "text-text-secondary hover:text-text-primary hover:bg-transparent",
          )}
        >
          <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
          <span className="text-[13px] font-display truncate leading-snug min-w-0">{displayTitle}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[280px] break-words">
        {displayTitle}
      </TooltipContent>
    </Tooltip>
  );
}

// =============================================================================
// 按日期分组：今天 / 昨天 / 更早
// 分组逻辑已抽到 ./chat/session-grouping，ChatHeader 与 SidebarSessionList 共享
// =============================================================================
