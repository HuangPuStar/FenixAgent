/**
 * space 分组头（折叠触发 + 名称 + 悬浮操作 + 内联重命名输入）。
 *
 * 默认分组不可重命名，只保留「在该分组新建会话」入口：它的名字由 i18n 提供，
 * 允许改名会让「未归属会话」的兜底语义从界面上消失。
 */

import { ChevronDown, ChevronRight, Pencil, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import { Button } from "../../../ui/button";
import { CollapsibleTrigger } from "../../../ui/collapsible";
import { SessionAction } from "./session-row";

export interface SpaceHeaderProps {
  /** 分组名称（默认分组为 i18n 文案） */
  name: string;
  /** 折叠状态：仅决定图标方向与无障碍标签（`aria-expanded` 由 CollapsibleTrigger 下发） */
  open: boolean;
  /** 是否允许重命名（默认分组为 false） */
  canRename: boolean;
  /** 提交重命名；名称已 trim、非空且与原值不同 */
  onRename?: (name: string) => void;
  /** 在该分组内新建会话（允许 async：实现的创建回执由其上层消费） */
  onCreateSession?: () => void | Promise<void>;
  /**
   * 拖动中指针压在本组上时的文字提示（静止时不传）。
   * 视觉上有底色与描边，这里补一份读屏可读的状态文本：颜色变化对读屏不可见。
   */
  dropHint?: string;
}

/** 分组头：名称行与重命名输入二选一渲染。 */
export function SpaceHeader({ name, open, canRename, onRename, onCreateSession, dropHint }: SpaceHeaderProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [editing, setEditing] = useState(false);
  // 草稿用非受控输入 + ref 读取：它只服务「提交时取一次值」，做成 state 会让每次按键重渲染整侧栏。
  // 输入框随 `editing` 挂载/卸载，因此 `defaultValue` 每次打开都取到当前分组名。
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
    else if (finished.current) triggerRef.current?.focus();
  }, [editing]);

  const startRename = () => {
    finished.current = false;
    setEditing(true);
  };
  const cancelRename = () => {
    finished.current = true;
    setEditing(false);
  };
  const submitRename = () => {
    if (finished.current) return;
    const next = inputRef.current?.value.trim() ?? "";
    cancelRename();
    // 空名与未改名都不提交：space 名以宿主数据为准，本地不制造占位名。
    if (!next || next === name) return;
    onRename?.(next);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-3 py-1">
        <input
          ref={inputRef}
          defaultValue={name}
          className="min-w-0 flex-1 border-b border-brand bg-transparent px-1 py-0.5 text-xs outline-none"
          aria-label={t("chat.components.acpMain.renameSpace")}
          placeholder={t("chat.components.acpMain.spaceNamePlaceholder")}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") submitRename();
            if (event.key === "Escape") cancelRename();
          }}
          onBlur={(event) => {
            if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-space-cancel]")))
              submitRename();
          }}
        />
        <Button
          data-space-cancel
          aria-label={t("chat.components.acpMain.cancel")}
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onPointerDown={(event) => event.preventDefault()}
          onClick={cancelRename}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="group/space flex items-center gap-0.5 px-2 pb-1 pt-3">
      <CollapsibleTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          aria-label={`${open ? t("chat.components.acpMain.collapseSpace") : t("chat.components.acpMain.expandSpace")}: ${name}`}
          className="min-w-0 flex-1 justify-start gap-1 px-1 py-0.5 hover:bg-transparent"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" />
          )}
          {/* 分组文案档位：`text-11` 是 `text-3xs`(10px) 的相邻档，`text-text-muted`（不再叠 70% alpha）。
              默认分组与真实 space 共用本组件，两者因此天然同款；不单独放大默认分组，避免同一个列表里
              出现两种分组头样式。 */}
          <span className="truncate text-11 font-semibold uppercase tracking-widest text-text-muted">{name}</span>
          {dropHint && <span className="sr-only">{dropHint}</span>}
        </Button>
      </CollapsibleTrigger>
      <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 group-hover/space:opacity-100 group-focus-within/space:opacity-100 pointer-coarse:opacity-100">
        {canRename && onRename && (
          <SessionAction label={t("chat.components.acpMain.renameSpace")} onClick={startRename}>
            <Pencil className="h-3 w-3" />
          </SessionAction>
        )}
        {onCreateSession && (
          <SessionAction label={t("chat.components.acpMain.newSessionInSpace")} onClick={onCreateSession}>
            <Plus className="h-3 w-3" />
          </SessionAction>
        )}
      </div>
    </div>
  );
}
