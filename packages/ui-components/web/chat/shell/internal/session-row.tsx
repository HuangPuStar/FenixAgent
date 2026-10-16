/**
 * 侧栏会话单行（常规行 / 内联重命名态 + 悬浮操作按钮）。
 *
 * 来源：从 `sidebar-session-list.tsx` 的行内 JSX 原样抽出——space 分组与时间分组两条渲染路径
 * 共用同一行，抽出后 `sidebar-session-list.tsx` 只做编排与分组（单文件 500 行红线）。
 * 纯化改动点：无（`cn`/UI 组件/`stripHtmlTags` 的包内导入随抽出一起迁移）。
 * 2026-10-15 拖放批次：操作条的可见条件从「仅悬浮」扩到「悬浮 / 行内焦点 / 粗指针」。
 *
 * 2026-10-16 删除行内「移动到…」菜单（`session-row-move-menu.tsx`，见 `space-session-drag.tsx`
 * 与 `docs/design/2026-10-15-chat-space-design.md` §6.4）：本行不再承载任何归属写入入口，
 * 归属只由指针拖拽写入；触屏与键盘因此暂时无法移动会话归属。
 */

import { Pencil, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/tooltip";
import { stripHtmlTags } from "../../lib/strip-html-tags";
import type { SessionSummary } from "../../types";

/** 会话行共享的选中/编辑态；由列表持有，行本身无状态。 */
export interface SessionRowState {
  /** 当前高亮会话（点击瞬间乐观置位，失败时由回退信号拉回） */
  activeId: string | null;
  /** 正在内联重命名的会话 */
  editingId: string | null;
  /** 重命名输入框的草稿标题 */
  editTitle: string;
  /** 真实当前会话：删除按钮据此禁用（活动会话不能删） */
  initialActiveSessionId: string | null;
}

/** 会话行的宿主回调集合。 */
export interface SessionRowActions {
  onSelect: (session: SessionSummary) => void;
  onEditTitleChange: (title: string) => void;
  onStartRename: (session: SessionSummary) => void;
  onSaveRename: (sessionId: string) => void;
  onCancelRename: () => void;
  onDelete: (sessionId: string) => void;
}

/** 渲染单条会话：内联重命名态或常规行（选中高亮 + 悬浮操作）。 */
export function SessionRow({
  session,
  state,
  actions,
}: {
  session: SessionSummary;
  state: SessionRowState;
  actions: SessionRowActions;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const isActive = session.sessionId === state.activeId;

  return (
    <div className="group relative" data-session-id={session.sessionId}>
      {state.editingId === session.sessionId ? (
        <div className="flex items-center gap-1 px-3 py-1">
          <input
            className="min-w-0 flex-1 border-b border-brand bg-transparent px-1 py-0.5 text-xs outline-none"
            value={state.editTitle}
            aria-label={t("chat.components.acpMain.rename")}
            onChange={(event) => actions.onEditTitleChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") actions.onSaveRename(session.sessionId);
              if (event.key === "Escape") actions.onCancelRename();
            }}
            onBlur={() => actions.onSaveRename(session.sessionId)}
          />
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={actions.onCancelRename}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <div
          // 选中底色取源 `.chat-session-row:has(button[aria-current="true"]), .chat-session-row.bg-brand/8`
          // 的生效值 `#eef4ff`（该规则特指度高于 `bg-brand/8` 工具类）。源规则的 `:has()` 分支在本包内
          // 不可达（子按钮用的是 `aria-current="page"`，见下方 SessionTitleButton），按「死规则删除」
          // 处理；行状态保留互斥两态：选中 / 未选中（hover）。
          className={cn(
            "mx-1.75 my-px flex items-center rounded-md",
            isActive ? "bg-indigo-50" : "hover:bg-surface-2/60",
          )}
        >
          <SessionTitleButton session={session} isActive={isActive} onSelect={() => actions.onSelect(session)} />
          {/*
            操作条三态可见：悬浮（鼠标）、`focus-within`（Tab 落到本行的标题按钮后即可继续 Tab 进动作）、
            `pointer-coarse`（触屏没有 hover，重命名 / 删除必须常驻）。
            仍用 `hidden`/`flex` 而不是透明态：后者会常驻占位，把标题的可读宽度永久让给动作按钮。
          */}
          <div className="hidden shrink-0 items-center gap-0.5 pr-1 group-hover:flex group-focus-within:flex pointer-coarse:flex">
            <SessionAction label={t("chat.components.acpMain.rename")} onClick={() => actions.onStartRename(session)}>
              <Pencil className="h-3 w-3" />
            </SessionAction>
            <SessionAction
              label={
                session.sessionId === state.initialActiveSessionId
                  ? t("chat.components.acpMain.cannotDeleteActiveSession")
                  : t("chat.components.acpMain.delete")
              }
              disabled={session.sessionId === state.initialActiveSessionId}
              destructive
              onClick={() => actions.onDelete(session.sessionId)}
            >
              <Trash2 className="h-3 w-3" />
            </SessionAction>
          </div>
        </div>
      )}
    </div>
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
          <span className="min-w-0 truncate leading-snug">{displayTitle}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-70 break-words">
        {displayTitle}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 列表内联图标动作按钮（重命名 / 删除 / 组头操作共用）。
 * 复制自源 `sidebar-session-list.tsx`；纯化改动点：无（space 组头复用同一按钮，避免第二套样式）。
 */
export function SessionAction({
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
  children: ReactNode;
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
