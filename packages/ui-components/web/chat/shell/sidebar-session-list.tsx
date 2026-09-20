import { Pencil, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { canDeleteSession } from "../lib/session-actions";
import { groupByRecency } from "../lib/session-grouping";
import { stripHtmlTags } from "../lib/strip-html-tags";
import type { SessionSummary } from "../types";
import type { ChatNotice } from "./chat-interface-types";

/**
 * 侧边栏会话列表属性。
 * 复制自 `packages/agent-runtime/web/components/chat/sidebar-session-list.tsx`。
 */
interface SidebarSessionListProps {
  initialActiveSessionId: string | null;
  onSelectSession: (session: SessionSummary) => void;
  sessions?: readonly SessionSummary[];
  loading?: boolean;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  /** 运行时提示出口（替代 sonner toast） */
  onNotice?: (notice: ChatNotice) => void;
}

/**
 * 紧凑的会话历史列表，负责重命名与删除确认交互。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/sidebar-session-list.tsx`。
 * 纯化改动点：`toast.error` 改为 `onNotice` 回调；`stripHtmlTags` / `cn` / UI 组件 / 类型
 * 全部改为包内导入；i18n 收敛到 `UI_COMPONENTS_NS`（键前缀 `chat.components.`）。
 */
export function SidebarSessionList({
  initialActiveSessionId,
  onSelectSession,
  sessions = [],
  loading = false,
  onRenameSession,
  onDeleteSession,
  onNotice,
}: SidebarSessionListProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; title: string } | null>(null);

  const handleStartRename = (session: SessionSummary) => {
    setEditingId(session.sessionId);
    setEditTitle(session.title ?? "");
  };
  const handleSaveRename = useCallback(
    (sessionId: string) => {
      const title = editTitle.trim();
      if (!title) return;
      try {
        onRenameSession(sessionId, title);
      } catch (error) {
        onNotice?.({
          level: "error",
          message: t("chat.components.acpMain.renameFailed", { message: error instanceof Error ? error.message : "" }),
        });
      }
      setEditingId(null);
      setEditTitle("");
    },
    [editTitle, onRenameSession, t, onNotice],
  );
  const handleCancelRename = () => {
    setEditingId(null);
    setEditTitle("");
  };

  const handleDelete = useCallback(
    (sessionId: string) => {
      if (!canDeleteSession(sessionId, initialActiveSessionId)) return;
      const target = sessions.find((session) => session.sessionId === sessionId);
      setDeleteTarget({
        sessionId,
        title: stripHtmlTags(target?.title?.trim() ?? "") || t("chat.components.acpMain.newSession"),
      });
    },
    [initialActiveSessionId, sessions, t],
  );

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    try {
      onDeleteSession(deleteTarget.sessionId);
      if (activeId === deleteTarget.sessionId) setActiveId(null);
    } catch (error) {
      onNotice?.({
        level: "error",
        message: t("chat.components.acpMain.deleteFailed", { message: error instanceof Error ? error.message : "" }),
      });
    } finally {
      setDeleteTarget(null);
    }
  }, [activeId, deleteTarget, onDeleteSession, t, onNotice]);

  useEffect(() => setActiveId(initialActiveSessionId), [initialActiveSessionId]);

  const groups = useMemo(
    () =>
      groupByRecency(sessions, {
        today: t("chat.components.acpMain.today"),
        yesterday: t("chat.components.acpMain.yesterday"),
        earlier: t("chat.components.acpMain.earlier"),
      }),
    [sessions, t],
  );

  if (loading && sessions.length === 0) {
    return (
      <div className="mx-auto my-8 h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    );
  }
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-8">
        <span className="text-xs font-display text-text-muted">{t("chat.components.acpMain.noSessions")}</span>
        <span className="text-[10px] text-text-muted">{t("chat.components.acpMain.clickToCreate")}</span>
      </div>
    );
  }

  return (
    <nav className="py-1" aria-label={t("chat.components.acpMain.historySessions")}>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="px-3 pb-1.5 pt-3">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted/70">
              {group.label}
            </span>
          </div>
          {group.sessions.map((session) => {
            const isActive = session.sessionId === activeId;
            return (
              <div key={session.sessionId} className="group relative">
                {editingId === session.sessionId ? (
                  <div className="flex items-center gap-1 px-3 py-1">
                    <input
                      className="min-w-0 flex-1 border-b border-brand bg-transparent px-1 py-0.5 text-[13px] outline-none"
                      value={editTitle}
                      aria-label={t("chat.components.acpMain.rename")}
                      onChange={(event) => setEditTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleSaveRename(session.sessionId);
                        if (event.key === "Escape") handleCancelRename();
                      }}
                      onBlur={() => handleSaveRename(session.sessionId)}
                    />
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCancelRename}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <div
                    className={cn(
                      "chat-session-row flex items-center",
                      isActive ? "bg-brand/8" : "hover:bg-surface-2/60",
                    )}
                  >
                    <SessionTitleButton
                      session={session}
                      isActive={isActive}
                      onSelect={() => {
                        setActiveId(session.sessionId);
                        onSelectSession(session);
                      }}
                    />
                    <div className="hidden shrink-0 items-center gap-0.5 pr-1 group-hover:flex">
                      <SessionAction
                        label={t("chat.components.acpMain.rename")}
                        onClick={() => handleStartRename(session)}
                      >
                        <Pencil className="h-3 w-3" />
                      </SessionAction>
                      <SessionAction
                        label={
                          session.sessionId === initialActiveSessionId
                            ? t("chat.components.acpMain.cannotDeleteActiveSession")
                            : t("chat.components.acpMain.delete")
                        }
                        disabled={session.sessionId === initialActiveSessionId}
                        destructive
                        onClick={() => handleDelete(session.sessionId)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </SessionAction>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat.components.acpMain.deleteSessionTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat.components.acpMain.deleteConfirm", { title: deleteTarget?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("chat.components.acpMain.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={handleConfirmDelete}>
              {t("chat.components.acpMain.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}

/** 会话标题按钮（含 Tooltip 全量标题）。复制自源 `sidebar-session-list.tsx`；纯化改动点：i18n 命名空间收敛。 */
function SessionTitleButton({
  session,
  isActive,
  onSelect,
}: {
  session: SessionSummary;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const displayTitle = stripHtmlTags(session.title?.trim() ?? "") || t("chat.components.acpMain.newSession");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          aria-current={isActive ? "page" : undefined}
          onClick={onSelect}
          className={cn(
            "min-w-0 flex-1 justify-start px-3 py-1.5 text-left",
            isActive
              ? "text-text-primary hover:bg-transparent"
              : "text-text-secondary hover:bg-transparent hover:text-text-primary",
          )}
        >
          <span className="min-w-0 truncate text-[13px] leading-snug">{displayTitle}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[280px] break-words">
        {displayTitle}
      </TooltipContent>
    </Tooltip>
  );
}

/** 会话行悬浮操作按钮（重命名/删除）。复制自源 `sidebar-session-list.tsx`；纯化改动点：无。 */
function SessionAction({
  label,
  disabled,
  destructive,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={label}
          className={cn("h-6 w-6 text-text-muted", destructive ? "hover:text-destructive" : "hover:text-brand")}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
