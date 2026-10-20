/**
 * 侧栏「新建空间」入口（内联命名输入）。
 *
 * 只发起 `onCreateSpace`：space 列表的刷新由上层负责（本包不持有 space 副本），失败提示由调用方
 * 统一给出。提交后立即收起输入——输入框不保留草稿，避免与宿主刷新回来的数据形成两份"待创建"状态。
 */

import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import { Button } from "../../../ui/button";

export interface CreateSpaceEntryProps {
  /** 提交新建；名称已 trim 且非空。未注入时不渲染入口 */
  onCreate?: (name: string) => void;
}

/** 新建空间入口：收起态为整行宽度的居中按钮，展开态为内联输入。 */
export function CreateSpaceEntry({ onCreate }: CreateSpaceEntryProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [editing, setEditing] = useState(false);
  // 草稿用非受控输入 + ref 读取：只在提交时取一次值，且输入框随 `editing` 重新挂载（草稿自然清空）。
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
    else if (finished.current) triggerRef.current?.focus();
  }, [editing]);

  if (!onCreate) return null;

  const cancel = () => {
    finished.current = true;
    setEditing(false);
  };
  const submit = () => {
    if (finished.current) return;
    const name = inputRef.current?.value.trim() ?? "";
    cancel();
    if (!name) return;
    onCreate(name);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-3 py-1">
        <input
          ref={inputRef}
          className="min-w-0 flex-1 border-b border-brand bg-transparent px-1 py-0.5 text-xs outline-none"
          aria-label={t("chat.components.acpMain.newSpace")}
          placeholder={t("chat.components.acpMain.spaceNamePlaceholder")}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") submit();
            if (event.key === "Escape") cancel();
          }}
          onBlur={(event) => {
            if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-space-cancel]")))
              submit();
          }}
        />
        <Button
          data-space-cancel
          aria-label={t("chat.components.acpMain.cancel")}
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onPointerDown={(event) => event.preventDefault()}
          onClick={cancel}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  // 收起态是整行宽度的居中按钮（描边变体给足可点性）：入口仍固定在分组列表上方，
  // 只放大尺寸与占宽，原来的创建流程、聚焦时机与触屏行为都不变。
  return (
    <div className="px-2 pt-2">
      <Button
        variant="outline"
        size="sm"
        ref={triggerRef}
        onClick={() => {
          finished.current = false;
          setEditing(true);
        }}
        className="w-full text-xs"
      >
        <Plus className="size-3.5" />
        {t("chat.components.acpMain.newSpace")}
      </Button>
    </div>
  );
}
