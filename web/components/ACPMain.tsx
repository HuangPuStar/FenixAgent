import { MessageSquare, Pencil, Pin, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { retryWithBackoff } from "@/src/lib/retry";
import type { ACPClient } from "../src/acp/client";
import type { AgentSessionInfo } from "../src/acp/types";
import { SessionsProvider, useSessions } from "../src/hooks/useSessions";
import { cn } from "../src/lib/utils";
import { ChatInterface, type ChatInterfaceHandle } from "./ChatInterface";
import { ChatHeader } from "./chat/ChatHeader";
import { groupByRecency } from "./chat/session-grouping";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ACPMainProps {
  client: ACPClient;
  agentId?: string;
  initialCwd?: string;
  readonly?: boolean;
  hideSidebar?: boolean;
  rcsSessionId?: string;
  scenePrompt?: string;
  contextKey?: string;
  onPromptComplete?: () => void;
}

/**
 * Main container — Anthropic sidebar + chat layout.
 * Sidebar: sectioned by recency, orange active state, warm raised bg.
 */
export function ACPMain({
  client,
  agentId,
  readonly,
  hideSidebar,
  rcsSessionId,
  scenePrompt,
  contextKey,
  onPromptComplete,
}: ACPMainProps) {
  const { t } = useTranslation("components");
  // 从 localStorage 读取侧边栏状态，默认 false（收起）
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const saved = localStorage.getItem("acp-sidebar-open");
      return saved === "true";
    } catch {
      return false;
    }
  });
  const [forcePopoverOpen, setForcePopoverOpen] = useState(false);
  const [initialActiveSessionId, setInitialActiveSessionId] = useState<string | null>(null);
  const chatRef = useRef<ChatInterfaceHandle>(null);
  const bootstrappedRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: client 变更时需重置 bootstrap 状态，否则新连接不会加载会话
  useEffect(() => {
    bootstrappedRef.current = false;
  }, [client]);

  // 保存侧边栏状态到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem("acp-sidebar-open", String(sidebarOpen));
    } catch (error) {
      console.warn("[ACPMain] Failed to save sidebar state:", error);
    }
  }, [sidebarOpen]);

  // Handle session selection
  // 历史会话切换由 ChatHeader popover 和 SidebarSessionList 共用：
  // 调用 client 的 loadSession/resumeSession 后必须同步更新 initialActiveSessionId，
  // 否则 ChatHeader 顶部展示的会话标题与 SidebarSessionList 的高亮会停留在旧值。
  // （ChatInterface 内部的 activeSessionId 由 client.sessionLoaded handler 单独维护，
  // 这里只是把当前选中 id 暴露给 header / sidebar。）
  const handleSelectSession = useCallback(
    async (session: AgentSessionInfo) => {
      // ChatInterface 正在等待 agent 响应时，阻止切换历史会话以避免状态混乱
      if (chatRef.current?.isLoading) {
        toast.warning(t("acpMain.chatBusy"));
        return;
      }
      try {
        if (client.supportsLoadSession) {
          await client.loadSession({ sessionId: session.sessionId, cwd: session.cwd });
        } else if (client.supportsResumeSession) {
          await client.resumeSession({ sessionId: session.sessionId, cwd: session.cwd });
        } else {
          throw new Error("Loading or resuming sessions is not supported by this agent.");
        }
        // 立即同步激活会话 id，让 ChatHeader 标题与 SidebarSessionList 高亮跟随切换
        setInitialActiveSessionId(session.sessionId);
      } catch (error) {
        console.error("Failed to load/resume session:", error);
      }
    },
    [client, t],
  );

  // 关闭侧边栏并打开弹窗
  const handleCloseSidebarAndOpenPopover = useCallback(() => {
    setSidebarOpen(false);
    setForcePopoverOpen(true);
  }, []);

  // 重置弹窗强制打开状态
  const handlePopoverOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setForcePopoverOpen(false);
    }
  }, []);

  // Bootstrap: load latest session or create new one.
  useEffect(() => {
    if (client.getState() !== "connected") return;
    if (bootstrappedRef.current) return;

    let cancelled = false;

    const bootstrap = async () => {
      try {
        // Wait for capabilities with exponential backoff
        await retryWithBackoff(
          async () => {
            if (cancelled) return;
            if (!client.supportsSessionList) {
              throw new Error("Capabilities not ready");
            }
          },
          { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 8000 },
        );
        if (cancelled) return;

        bootstrappedRef.current = true;
        const response = await client.listSessions();
        if (cancelled) return;

        const sessions = Array.isArray(response?.sessions) ? response.sessions : [];
        const latest = [...sessions].sort((a, b) => {
          const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return timeB - timeA;
        })[0];

        if (latest) {
          setInitialActiveSessionId(latest.sessionId);
          await handleSelectSession(latest);
          return;
        }

        console.log("[ACPMain] No existing sessions found, creating new session");
        chatRef.current?.newSession();
      } catch (error) {
        // Capabilities never became available — create session directly
        if (!client.supportsSessionList && !cancelled) {
          console.log("[ACPMain] Session list not supported, creating new session directly");
          bootstrappedRef.current = true;
          chatRef.current?.newSession();
          return;
        }
        bootstrappedRef.current = false;
        console.warn("[ACPMain] Failed to bootstrap latest session:", error);
      }
    };

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, [client, handleSelectSession]);

  return (
    // root 加 p-3 gap-3：让顶部 ChatHeader 浮动卡片与下方内容统一外边距，
    // 形成上下两个玻璃磨砂卡片悬浮在子页面背景上的视觉效果。
    // acp-main-root：作为窄屏容器（如 MetaAgentPanel）收紧 padding 的 CSS 作用域钩子
    <SessionsProvider client={client}>
      <div className="acp-main-root flex h-full w-full flex-col gap-3 p-3">
        {/* 顶部 ChatHeader — 跨整个宽度，承担会话面板开关 + 当前会话标题 + popover 历史会话列表 */}
        {/* readonly 时整体隐藏 */}
        {!readonly && (
          <ChatHeader
            client={client}
            activeSessionId={initialActiveSessionId}
            onSelectSession={handleSelectSession}
            onNewSession={() => chatRef.current?.newSession()}
            // hideSidebar 场景（嵌入到外部）下不提供切换按钮，避免出现"开关一个永远不显示的面板"
            onToggleSidebar={!hideSidebar ? () => setSidebarOpen((v) => !v) : undefined}
            sidebarOpen={sidebarOpen}
            forceOpen={forcePopoverOpen}
            onPopoverChange={handlePopoverOpenChange}
          />
        )}

        {/* 主体：横向 sidebar + chat */}
        <div className="flex flex-1 min-h-0 gap-3">
          {/* 左侧 sidebar — 仅在 sidebarOpen 且非 readonly/hideSidebar 时渲染，关闭时完全不占位 */}
          {!readonly && !hideSidebar && sidebarOpen && (
            <div
              className="hidden md:flex flex-col bg-surface-1 transition-all duration-200 flex-shrink-0 w-64 rounded-xl"
              style={{ boxShadow: "var(--shadow-card)" }}
            >
              {/* 头部：标题 + 新会话按钮 + 钉子按钮 */}
              <div className="flex items-center justify-between px-3 py-4">
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
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleCloseSidebarAndOpenPopover}
                    className="h-7 w-7 text-text-muted hover:text-text-primary hover:bg-surface-2/60"
                    title={t("acpMain.closeToPopover")}
                  >
                    <Pin className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* 会话列表 */}
              <ScrollArea className="flex-1">
                <SidebarSessionList
                  client={client}
                  initialActiveSessionId={initialActiveSessionId}
                  onSelectSession={handleSelectSession}
                />
              </ScrollArea>
            </div>
          )}

          {/* 聊天区域 */}
          <div className="flex-1 flex flex-col min-w-0">
            <ChatInterface
              ref={chatRef}
              client={client}
              agentId={agentId}
              readonly={readonly}
              hideContextPanel={true}
              rcsSessionId={rcsSessionId}
              scenePrompt={scenePrompt}
              contextKey={contextKey}
              onSessionCreated={(sessionId) => setInitialActiveSessionId(sessionId)}
              onPromptComplete={onPromptComplete}
            />
          </div>
        </div>
      </div>
    </SessionsProvider>
  );
}

// =============================================================================
// 侧边栏会话列表 — Anthropic 分段式（今天/昨天/更早）
// =============================================================================

function SidebarSessionList({
  client,
  initialActiveSessionId,
  onSelectSession,
}: {
  client: ACPClient;
  initialActiveSessionId: string | null;
  onSelectSession: (session: AgentSessionInfo) => void;
}) {
  const { t } = useTranslation("components");
  const { sessions, loading, mutate, refresh } = useSessions();
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
        // 乐观更新：本地立即修改标题
        mutate(sessions.map((s) => (s.sessionId === sessionId ? { ...s, title } : s)));
        client.renameSession({ sessionId, title });
        // 从服务端拉取最新数据以同步（agent 处理 rename 需要时间，异步确认）
        refresh();
      } catch (err) {
        toast.error(`重命名失败: ${(err as Error).message}`);
      }
      setEditingId(null);
      setEditTitle("");
    },
    [editTitle, client, sessions, mutate, refresh],
  );
  const handleCancelRename = () => {
    setEditingId(null);
    setEditTitle("");
  };

  // 删除处理
  const handleDelete = useCallback(
    async (sessionId: string) => {
      try {
        // 乐观更新：本地立即移除
        mutate(sessions.filter((s) => s.sessionId !== sessionId));
        await client.deleteSession({ sessionId });
        refresh(); // 从服务端同步
        if (activeId === sessionId) {
          setActiveId(null);
        }
      } catch (err) {
        toast.error(`删除失败: ${(err as Error).message}`);
      }
    },
    [client, activeId, sessions, mutate, refresh],
  );

  useEffect(() => {
    if (initialActiveSessionId) {
      setActiveId(initialActiveSessionId);
    }
  }, [initialActiveSessionId]);

  const sorted = useMemo(
    () =>
      [...sessions].sort((a, b) => {
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
                        onSelectSession(session);
                      }}
                    />
                    {/* 悬停时显示操作按钮 */}
                    <div className="hidden group-hover:flex items-center gap-0.5 pr-1 flex-shrink-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-text-muted hover:text-brand"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartRename(session);
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
  session: AgentSessionInfo;
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
  const displayTitle = session.title?.trim() ? session.title : t("acpMain.newSession");

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
