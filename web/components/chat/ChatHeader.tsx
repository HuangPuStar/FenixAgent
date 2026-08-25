import type { AgentSessionInfo } from "@fenix/chat-channel";
import {
  ChevronDown,
  Loader2,
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { stripHtmlTags } from "../../src/lib/strip-html-tags";
import { cn } from "../../src/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { canDeleteSession } from "./session-actions";
import { groupByRecency } from "./session-grouping";

interface ChatHeaderProps {
  /** 当前激活的会话 ID（与 ChatInterface 内 activeSessionId 对齐） */
  activeSessionId: string | null;
  /** 在 popover 中选中某个历史会话时回调，由父组件负责调用 loadSession/resumeSession */
  onSelectSession: (session: AgentSessionInfo) => void | Promise<void>;
  /** 新建会话回调，由父组件调用 newSession 流程 */
  onNewSession?: () => void;
  /** 切换左侧会话面板开/关。提供时显示最左侧的 PanelLeft 切换按钮（readonly / hideSidebar 场景不传） */
  onToggleSidebar?: () => void;
  /** 当前会话面板是否展开（true 显示 PanelLeftClose，false 显示 PanelLeft） */
  sidebarOpen?: boolean;
  /** 手动控制弹窗打开状态（从外部控制弹窗打开） */
  forceOpen?: boolean;
  /** 弹窗状态变化回调 */
  onPopoverChange?: (open: boolean) => void;
  className?: string;
  /** Phase B: 外部注入 sessions（来自 Yjs chatState） */
  sessions?: readonly { sessionId: string; title?: string | null; updatedAt?: string | null }[];
  loading?: boolean;
  /** 重命名会话回调 */
  onRenameSession?: (sessionId: string, title: string) => void;
  /** 删除会话回调 */
  onDeleteSession?: (sessionId: string) => void;
  /** 是否显示顶部会话列表入口；会话列表统一由侧边栏承载。 */
  showSessionList?: boolean;
}

/**
 * ChatHeader —— 顶部会话标题栏。
 *
 * 横跨整个 chat 子页面顶部，最左侧（可选）为会话面板切换按钮，紧接着是当前会话标题按钮，
 * 点击标题按钮触发 popover，展开按"今天/昨天/更早"分组的历史会话列表。与 ACPMain 左侧
 * SidebarSessionList 共享同一份分组逻辑，但视觉风格改为 popover 形式以适配无侧边栏场景。
 *
 * 数据自包含：组件内部独立监听 capabilitiesChange / connectionState / 30s 轮询，
 * 避免与 ChatInterface 的会话状态耦合。
 */
export function ChatHeader({
  activeSessionId,
  onSelectSession,
  onNewSession,
  onToggleSidebar,
  sidebarOpen = false,
  forceOpen = false,
  onPopoverChange,
  className,
  sessions = [],
  loading = false,
  onRenameSession,
  onDeleteSession,
  showSessionList = false,
}: ChatHeaderProps) {
  const { t } = useTranslation("components");
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // 钉子状态与侧边栏状态同步：侧边栏打开时即为钉住状态
  const pinned = sidebarOpen;
  const SidebarToggleIcon = pinned ? PanelLeftClose : PanelLeft;
  // 内联重命名状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; title: string } | null>(null);

  // 外部控制弹窗打开
  useEffect(() => {
    if (forceOpen) {
      setOpen(true);
    }
  }, [forceOpen]);

  // 当前会话标题：从 sessions 中按 activeSessionId 命中；缺失则用默认文案兜底
  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const activeTitle = stripHtmlTags(activeSession?.title?.trim() || "") || t("chatHeader.newSession");

  // 搜索过滤 + 按"今天/昨天/更早"分组（共享 SidebarSessionList 同款逻辑）
  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((s) => s.title?.toLowerCase().includes(query) || s.sessionId.toLowerCase().includes(query));
  }, [sessions, searchQuery]);

  const groups = useMemo(
    () =>
      groupByRecency(filteredSessions, {
        today: t("acpMain.today"),
        yesterday: t("acpMain.yesterday"),
        earlier: t("acpMain.earlier"),
      }),
    [filteredSessions, t],
  );

  // 选中会话：交由父组件执行 loadSession/resumeSession，关闭 popover
  const handleSelect = useCallback(
    async (session: AgentSessionInfo) => {
      try {
        await onSelectSession(session);
        setOpen(false);
        setSearchQuery("");
      } catch (err) {
        console.error("[ChatHeader] Failed to select session:", err);
      }
    },
    [onSelectSession],
  );

  const handleNewSession = useCallback(() => {
    setOpen(false);
    setSearchQuery("");
    onNewSession?.();
  }, [onNewSession]);

  // 在 popover 内按 Esc 时同时清空搜索，恢复全量列表
  const handleSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape" && searchQuery) {
        e.stopPropagation();
        setSearchQuery("");
      }
    },
    [searchQuery],
  );

  // 钉子按钮处理逻辑
  const handlePinToggle = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (pinned) {
        // 已钉住状态：收起侧边栏（相当于解除钉住）
        onToggleSidebar?.();
      } else {
        // 未钉住状态：展开侧边栏（相当于钉住），然后关闭弹窗
        if (!sidebarOpen) {
          onToggleSidebar?.();
        }
        setOpen(false); // 关闭弹窗
      }
    },
    [pinned, sidebarOpen, onToggleSidebar],
  );

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
        onRenameSession?.(sessionId, title);
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

  // 删除处理：通过 AlertDialog 二次确认后再删除；确认后调用后端 delete_session
  // 并触发 session/list 刷新，列表由聚合层投影回前端。
  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (!canDeleteSession(sessionId, activeSessionId)) return;
      const target = sessions.find((s) => s.sessionId === sessionId);
      setDeleteTarget({
        sessionId,
        title: stripHtmlTags(target?.title?.trim() || "") || t("acpMain.newSession"),
      });
    },
    [activeSessionId, sessions, t],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      onDeleteSession?.(deleteTarget.sessionId);
    } catch (err) {
      toast.error(`删除失败: ${(err as Error).message}`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, onDeleteSession]);

  return (
    <div
      className={cn(
        // chat-header-card：玻璃磨砂浮动卡片（圆角 + 阴影），替代原 border-b 横条；
        // 外层 ACPMain 的 padding 负责让卡片悬浮于子页面顶部
        "chat-header-card flex items-center gap-2 h-11 px-3 flex-shrink-0",
        className,
      )}
    >
      {/* 会话列表统一由侧边栏承载，顶部仅展示当前会话标题。 */}
      {showSessionList && (
        <Popover
          open={open}
          onOpenChange={(newOpen) => {
            setOpen(newOpen);
            onPopoverChange?.(newOpen);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-text-primary hover:bg-surface-2/60 max-w-[70%]"
              // 顶住布局右侧不被截断：title 提供原生 tooltip 兜底
              title={activeTitle}
            >
              <MessageSquare className="h-3.5 w-3.5 text-text-muted flex-shrink-0" />
              <span className="text-[13px] font-display truncate min-w-0">{activeTitle}</span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 text-text-muted flex-shrink-0 transition-transform duration-150",
                  open && "rotate-180",
                )}
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            // 触发器下边缘 + 4px 间距，宽度足够展示分组与时间戳
            sideOffset={4}
            className="w-80 p-0 overflow-hidden"
          >
            <div className="flex flex-col max-h-[60vh]">
              {/* 顶部：搜索 + 刷新 + 新建 + 钉子按钮 */}
              <div className="flex items-center gap-1.5 p-2 border-b border-border/40">
                <Search className="h-3.5 w-3.5 text-text-muted flex-shrink-0 ml-1" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t("chatHeader.searchPlaceholder")}
                  className="h-7 border-0 focus-visible:ring-0 shadow-none text-xs"
                />
                {loading && <Loader2 className="h-3.5 w-3.5 text-text-muted animate-spin flex-shrink-0" />}
                {onNewSession && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleNewSession}
                    className="h-7 w-7 text-text-muted hover:text-brand hover:bg-brand/10 flex-shrink-0"
                    title={t("acpMain.newSession")}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                )}
                {/* 侧边栏收起/展开按钮 */}
                {onToggleSidebar && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handlePinToggle}
                    className={cn(
                      "h-7 w-7 flex-shrink-0",
                      pinned
                        ? "text-brand bg-brand/10 hover:bg-brand/20"
                        : "text-text-muted hover:text-text-primary hover:bg-surface-2/60",
                    )}
                    title={t(pinned ? "chatHeader.hideSessions" : "chatHeader.showSessions")}
                    aria-label={t(pinned ? "chatHeader.hideSessions" : "chatHeader.showSessions")}
                    aria-pressed={pinned}
                  >
                    <SidebarToggleIcon className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              {/* 会话列表 */}
              <ScrollArea className="flex-1 min-h-0">
                {sessions.length === 0 && !loading && (
                  <div className="flex flex-col items-center justify-center py-8 gap-1">
                    <span className="text-xs text-text-muted font-display">{t("acpMain.noSessions")}</span>
                    <span className="text-[10px] text-text-muted">{t("acpMain.clickToCreate")}</span>
                  </div>
                )}

                {filteredSessions.length === 0 && searchQuery && (
                  <div className="flex flex-col items-center justify-center py-8">
                    <span className="text-xs text-text-muted">{t("chatHeader.noResults")}</span>
                  </div>
                )}

                {groups.map((group, gi) => (
                  <div key={group.label}>
                    {gi > 0 && <div className="mx-3 my-1.5 border-t border-border/40" />}
                    <div className="px-4 pt-2 pb-1">
                      <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-text-muted/70">
                        {group.label}
                      </span>
                    </div>
                    {group.sessions.map((session) => {
                      const isActive = session.sessionId === activeSessionId;
                      const isEditing = editingId === session.sessionId;

                      // 标题清洗：剔除混入的 HTML 标签（如 <system-reminder>），清洗后为空则回退到"新会话"占位
                      const displayTitle = stripHtmlTags(session.title?.trim() || "") || t("acpMain.newSession");

                      // 内联重命名模式
                      if (isEditing) {
                        return (
                          <div key={session.sessionId} className="flex items-center gap-1 px-4 py-1.5">
                            <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-50 text-text-muted" />
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
                            <button
                              type="button"
                              className="flex-shrink-0 p-1 text-text-muted hover:text-text-primary rounded"
                              onClick={handleCancelRename}
                              aria-label="取消"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={session.sessionId}
                          className={cn("group flex items-center", isActive ? "bg-brand/8" : "hover:bg-surface-2/60")}
                        >
                          <Button
                            variant="ghost"
                            onClick={() => handleSelect(session as AgentSessionInfo)}
                            className={cn(
                              "flex-1 flex items-center gap-2 px-4 py-2 text-left justify-start rounded-none",
                              isActive
                                ? "text-text-primary hover:bg-transparent"
                                : "text-text-secondary hover:text-text-primary hover:bg-transparent",
                            )}
                            title={session.title || session.sessionId}
                          >
                            <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
                            <span className="text-[13px] font-display truncate leading-snug flex-1 min-w-0">
                              {displayTitle}
                            </span>
                            {isActive && (
                              <span className="h-1.5 w-1.5 rounded-full bg-brand flex-shrink-0" aria-hidden />
                            )}
                          </Button>
                          {/* 悬停时显示操作按钮 */}
                          <div className="hidden group-hover:flex items-center gap-0.5 pr-1 flex-shrink-0">
                            <button
                              type="button"
                              className="h-6 w-6 p-0 flex items-center justify-center rounded text-text-muted hover:text-brand"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStartRename(session as AgentSessionInfo);
                              }}
                              aria-label={t("acpMain.rename")}
                              title={t("acpMain.rename")}
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex">
                                  <button
                                    type="button"
                                    disabled={isActive}
                                    className="h-6 w-6 p-0 flex items-center justify-center rounded text-text-muted hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-text-muted"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDelete(session.sessionId);
                                    }}
                                    aria-label={isActive ? t("acpMain.cannotDeleteActiveSession") : t("acpMain.delete")}
                                    title={isActive ? t("acpMain.cannotDeleteActiveSession") : t("acpMain.delete")}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {isActive ? t("acpMain.cannotDeleteActiveSession") : t("acpMain.delete")}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </ScrollArea>
            </div>
          </PopoverContent>
        </Popover>
      )}
      {!showSessionList && (
        <div className="flex items-center gap-1.5 h-8 px-2 text-text-primary max-w-[70%]">
          {onToggleSidebar && (
            <Button
              variant="ghost"
              size="icon"
              onClick={handlePinToggle}
              className={cn(
                "h-7 w-7 flex-shrink-0",
                pinned
                  ? "text-brand bg-brand/10 hover:bg-brand/20"
                  : "text-text-muted hover:text-text-primary hover:bg-surface-2/60",
              )}
              title={t(pinned ? "chatHeader.hideSessions" : "chatHeader.showSessions")}
              aria-label={t(pinned ? "chatHeader.hideSessions" : "chatHeader.showSessions")}
              aria-pressed={pinned}
            >
              <SidebarToggleIcon className="h-3.5 w-3.5" />
            </Button>
          )}
          <div className="flex items-center gap-1.5 min-w-0" title={activeTitle}>
            <MessageSquare className="h-3.5 w-3.5 text-text-muted flex-shrink-0" />
            <span className="text-[13px] font-display truncate min-w-0">{activeTitle}</span>
          </div>
        </div>
      )}

      {/* 右侧占位：留给后续模型/连接状态展示，保持 header 布局稳定 */}
      <div className="flex-1" />

      {/* 会话删除二次确认 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("acpMain.deleteSessionTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("acpMain.deleteConfirm", { title: deleteTarget?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>{t("acpMain.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600"
              onClick={() => void handleConfirmDelete()}
            >
              {t("acpMain.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
