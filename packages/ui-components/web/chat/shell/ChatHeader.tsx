import { ChevronDown, Loader2, MessageSquare, PanelLeft, PanelLeftClose, Plus, Search } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { ScrollArea } from "../../ui/scroll-area";
import { canDeleteSession } from "../lib/session-actions";
import { groupByRecency } from "../lib/session-grouping";
import { stripHtmlTags } from "../lib/strip-html-tags";
import type { AgentSessionInfo } from "../types";
import type { ChatNotice } from "./chat-interface-types";
import { type ChatHeaderSessionItem, ChatHeaderSessionRow } from "./internal/chat-header-session-row";

/**
 * 顶部卡片样式（源两段规则按级联的**生效值**落地）：
 * - `chat-design-composer.css` 的 `.chat-header-card` 段：独立渲染时是玻璃磨砂卡片
 *   （半透明底 + `blur(16px) saturate(180%)` + 16px 圆角），高度沿用组件原有的 `h-11`（44px）。
 * - `chat-design-shell.css` 的 `.acp-main-root .chat-header-card` 段：在外壳内（宿主真实用法）
 *   特指度更高，压过玻璃样式 —— 45px 高、直角、白底、无 backdrop-filter、只留底边 `#eef1f5`，
 *   `:hover` 阴影归零。用祖先变体 `[.acp-main-root_&]:` 表达（`acp-main-root` 是外壳根节点的既有类名，
 *   同时是宿主 `index.css` 的作用域钩子，故保留）。
 * - 暗色：源为 `.dark` 类切换（本仓库 `dark:` 变体语义是 `prefers-color-scheme`，不可替换），
 *   故写 `[.dark_&]:`。暗色下两段的生效值一致（外壳段不改暗色取值），故几何类规则不排除暗色，
 *   只有「白底 / 无边框 / 底边分隔线」这三条颜色类规则用 `:not(.dark *)` 与暗色互斥，
 *   避免依赖两条同级工具类的生成顺序。
 * - `:hover` 阴影：源文件里 `.chat-header-card:hover` 有两支（前者 `0.06`、后者 `0.3` 且无 `.dark` 前缀），
 *   后者靠文件顺序对所有模式生效，故取 `rgba(0,0,0,0.3)`；外壳内的 `:hover { box-shadow: none }`
 *   特指度更高，由外壳变体覆盖。
 * - `@supports` 回退：`backdrop-filter` 不支持时改用 `--color-surface-1`（源条件逐字表达；
 *   外壳内该值与外壳白底一致，或让位于暗色规则）。
 */
const HEADER_CARD_CLASS = cn(
  "flex h-11 shrink-0 items-center gap-2 overflow-hidden px-3",
  "rounded-[16px] border border-[rgba(255,255,255,0.9)] bg-[rgba(255,255,255,0.72)] shadow-none",
  "backdrop-blur-[16px] backdrop-saturate-[180%] hover:shadow-[0_4px_20px_rgba(0,0,0,0.3)]",
  "[transition:border-color_0.2s_ease,box-shadow_0.2s_ease]",
  // 外壳内（宿主 ACPMain 的 .acp-main-root 子树）：几何与 hover 阴影对明暗两态一致。
  "[.acp-main-root_&]:h-[45px] [.acp-main-root_&]:rounded-none [.acp-main-root_&]:[backdrop-filter:none] [.acp-main-root_&]:hover:shadow-none",
  // 外壳内浅色：白底 + 仅底边分隔线（源 `border: 0; border-bottom: 1px solid #eef1f5`）。
  "[.acp-main-root_&:not(.dark_*)]:bg-white [.acp-main-root_&:not(.dark_*)]:border-x-0 [.acp-main-root_&:not(.dark_*)]:border-t-0 [.acp-main-root_&:not(.dark_*)]:border-b [.acp-main-root_&:not(.dark_*)]:border-b-[#eef1f5]",
  // 暗色（源 `:root.dark .chat-header-card, .dark .chat-header-card`）。
  "[.dark_&]:border-[rgba(255,255,255,0.08)] [.dark_&]:bg-[rgba(45,45,47,0.72)]",
  // backdrop-filter 不支持时的回退（源 `@supports not ((backdrop-filter: blur(16px)) or (-webkit-backdrop-filter: blur(16px)))`）。
  "[@supports_not_((backdrop-filter:blur(16px))_or_(-webkit-backdrop-filter:blur(16px)))]:bg-[var(--color-surface-1)]",
);

/**
 * ChatHeader 属性。
 * 复制自 `packages/agent-runtime/web/components/chat/ChatHeader.tsx`。
 */
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
  sessions?: readonly ChatHeaderSessionItem[];
  loading?: boolean;
  /** 重命名会话回调 */
  onRenameSession?: (sessionId: string, title: string) => void;
  /** 删除会话回调 */
  onDeleteSession?: (sessionId: string) => void;
  /** 是否显示顶部会话列表入口；会话列表统一由侧边栏承载。 */
  showSessionList?: boolean;
  /** 运行时提示出口（替代 sonner toast；源在重命名/删除失败时提示硬编码中文文案） */
  onNotice?: (notice: ChatNotice) => void;
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
 *
 * 复制自 `packages/agent-runtime/web/components/chat/ChatHeader.tsx`。
 * 纯化改动点：`toast.error` 改为 `onNotice` 回调（文案逐字保留）；`cn` / UI 组件 / `stripHtmlTags`
 * 改为包内导入；i18n 收敛到 `UI_COMPONENTS_NS`（键前缀 `chat.components.`）；单行渲染抽到
 * `./internal/chat-header-session-row` 以满足单文件 500 行约束。
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
  onNotice,
}: ChatHeaderProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
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
  const activeTitle = stripHtmlTags(activeSession?.title?.trim() || "") || t("chat.components.chatHeader.newSession");

  // 搜索过滤 + 按"今天/昨天/更早"分组（共享 SidebarSessionList 同款逻辑）
  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((s) => s.title?.toLowerCase().includes(query) || s.sessionId.toLowerCase().includes(query));
  }, [sessions, searchQuery]);

  const groups = useMemo(
    () =>
      groupByRecency(filteredSessions, {
        today: t("chat.components.acpMain.today"),
        yesterday: t("chat.components.acpMain.yesterday"),
        earlier: t("chat.components.acpMain.earlier"),
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
        onNotice?.({ level: "error", message: `重命名失败: ${(err as Error).message}` });
      }
      setEditingId(null);
      setEditTitle("");
    },
    [editTitle, onRenameSession, onNotice],
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
        title: stripHtmlTags(target?.title?.trim() || "") || t("chat.components.acpMain.newSession"),
      });
    },
    [activeSessionId, sessions, t],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      onDeleteSession?.(deleteTarget.sessionId);
    } catch (err) {
      onNotice?.({ level: "error", message: `删除失败: ${(err as Error).message}` });
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, onDeleteSession, onNotice]);

  return (
    <div
      className={cn(
        // 顶部卡片：玻璃磨砂浮动卡片（独立渲染）／外壳内的平面标题栏（`.acp-main-root` 子树），
        // 两种形态与暗色覆写见 HEADER_CARD_CLASS 注释
        HEADER_CARD_CLASS,
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
                  placeholder={t("chat.components.chatHeader.searchPlaceholder")}
                  className="h-7 border-0 focus-visible:ring-0 shadow-none text-xs"
                />
                {loading && <Loader2 className="h-3.5 w-3.5 text-text-muted animate-spin flex-shrink-0" />}
                {onNewSession && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleNewSession}
                    className="h-7 w-7 text-text-muted hover:text-brand hover:bg-brand/10 flex-shrink-0"
                    title={t("chat.components.acpMain.newSession")}
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
                    title={t(
                      pinned ? "chat.components.chatHeader.hideSessions" : "chat.components.chatHeader.showSessions",
                    )}
                    aria-label={t(
                      pinned ? "chat.components.chatHeader.hideSessions" : "chat.components.chatHeader.showSessions",
                    )}
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
                    <span className="text-xs text-text-muted font-display">
                      {t("chat.components.acpMain.noSessions")}
                    </span>
                    <span className="text-[10px] text-text-muted">{t("chat.components.acpMain.clickToCreate")}</span>
                  </div>
                )}

                {filteredSessions.length === 0 && searchQuery && (
                  <div className="flex flex-col items-center justify-center py-8">
                    <span className="text-xs text-text-muted">{t("chat.components.chatHeader.noResults")}</span>
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
                    {group.sessions.map((session) => (
                      <ChatHeaderSessionRow
                        key={session.sessionId}
                        session={session}
                        isActive={session.sessionId === activeSessionId}
                        isEditing={editingId === session.sessionId}
                        editTitle={editTitle}
                        onEditTitleChange={setEditTitle}
                        onSelect={() => handleSelect(session as AgentSessionInfo)}
                        onStartRename={() => handleStartRename(session as AgentSessionInfo)}
                        onSaveRename={() => handleSaveRename(session.sessionId)}
                        onCancelRename={handleCancelRename}
                        onDelete={() => handleDelete(session.sessionId)}
                      />
                    ))}
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
              title={t(pinned ? "chat.components.chatHeader.hideSessions" : "chat.components.chatHeader.showSessions")}
              aria-label={t(
                pinned ? "chat.components.chatHeader.hideSessions" : "chat.components.chatHeader.showSessions",
              )}
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
            <AlertDialogTitle>{t("chat.components.acpMain.deleteSessionTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat.components.acpMain.deleteConfirm", { title: deleteTarget?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
              {t("chat.components.acpMain.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600"
              onClick={() => void handleConfirmDelete()}
            >
              {t("chat.components.acpMain.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
