/**
 * ChatHeader 弹窗会话列表的单行（内联重命名态 + 常规行 + 悬浮操作按钮）。
 *
 * 来源：从 `packages/agent-runtime/web/components/chat/ChatHeader.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除） 的 popover 列表分支
 * （`group.sessions.map(...)` 内部 JSX）原样抽出，用于把 ChatHeader 控制在 500 行红线内。
 * 纯化改动点：`cn` / UI 组件 / `stripHtmlTags` 改为包内导入；i18n 收敛到 `UI_COMPONENTS_NS`
 * （键前缀 `chat.components.`）；JSX 结构与类名逐字保留（含源有意的硬编码 `aria-label="取消"`）。
 */

import { MessageSquare, Pencil, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/tooltip";
import { stripHtmlTags } from "../../lib/strip-html-tags";

/** 会话列表行所需的最小会话字段（与 ChatHeader `sessions` prop 的结构子集一致）。 */
export interface ChatHeaderSessionItem {
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
}

/** ChatHeaderSessionRow 属性。 */
export interface ChatHeaderSessionRowProps {
  session: ChatHeaderSessionItem;
  isActive: boolean;
  isEditing: boolean;
  editTitle: string;
  onEditTitleChange: (title: string) => void;
  onSelect: () => void;
  onStartRename: () => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
}

/**
 * 渲染单条会话：编辑态输入框或常规行；标题经 `stripHtmlTags` 清洗后回退到"新会话"占位。
 *
 * 复制自 `ChatHeader.tsx`（抽出为内部件）；纯化改动点见文件头。
 */
export function ChatHeaderSessionRow({
  session,
  isActive,
  isEditing,
  editTitle,
  onEditTitleChange,
  onSelect,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onDelete,
}: ChatHeaderSessionRowProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  // 标题清洗：剔除混入的 HTML 标签（如 <system-reminder>），清洗后为空则回退到"新会话"占位
  const displayTitle = stripHtmlTags(session.title?.trim() || "") || t("chat.components.acpMain.newSession");

  // 内联重命名模式
  if (isEditing) {
    return (
      <div className="flex items-center gap-1 px-4 py-1.5">
        <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-50 text-text-muted" />
        <input
          className="flex-1 text-[13px] font-display bg-transparent border-b border-brand text-text-primary outline-none px-1 py-0.5"
          value={editTitle}
          onChange={(e) => onEditTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSaveRename();
            if (e.key === "Escape") onCancelRename();
          }}
          onBlur={onSaveRename}
        />
        <button
          type="button"
          className="flex-shrink-0 p-1 text-text-muted hover:text-text-primary rounded"
          onClick={onCancelRename}
          aria-label="取消"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className={cn("group flex items-center", isActive ? "bg-brand/8" : "hover:bg-surface-2/60")}>
      <Button
        variant="ghost"
        onClick={onSelect}
        className={cn(
          "flex-1 flex items-center gap-2 px-4 py-2 text-left justify-start rounded-none",
          isActive
            ? "text-text-primary hover:bg-transparent"
            : "text-text-secondary hover:text-text-primary hover:bg-transparent",
        )}
        title={session.title || session.sessionId}
      >
        <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
        <span className="text-[13px] font-display truncate leading-snug flex-1 min-w-0">{displayTitle}</span>
        {isActive && <span className="h-1.5 w-1.5 rounded-full bg-brand flex-shrink-0" aria-hidden />}
      </Button>
      {/* 悬停时显示操作按钮 */}
      <div className="hidden group-hover:flex items-center gap-0.5 pr-1 flex-shrink-0">
        <button
          type="button"
          className="h-6 w-6 p-0 flex items-center justify-center rounded text-text-muted hover:text-brand"
          onClick={(e) => {
            e.stopPropagation();
            onStartRename();
          }}
          aria-label={t("chat.components.acpMain.rename")}
          title={t("chat.components.acpMain.rename")}
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
                  onDelete();
                }}
                aria-label={
                  isActive
                    ? t("chat.components.acpMain.cannotDeleteActiveSession")
                    : t("chat.components.acpMain.delete")
                }
                title={
                  isActive
                    ? t("chat.components.acpMain.cannotDeleteActiveSession")
                    : t("chat.components.acpMain.delete")
                }
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {isActive ? t("chat.components.acpMain.cannotDeleteActiveSession") : t("chat.components.acpMain.delete")}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
