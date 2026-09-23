import { Button } from "@fenix/ui-components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * 键值编辑器（inputs / outputs / params）的两个行操作按钮：删除（含二次确认态）与追加。
 *
 * 为什么共享：这三段 JSX 此前逐字重复——删除按钮在 `InputsEditor` 与 `OutputsEditor` 各一份（10 行），
 * 追加按钮在三个编辑器各一份（4 行）。两者都不带领域逻辑（确认态由调用点的 `isConfirming` 算出、点下去
 * 做什么由调用点给），重复的只有同一串类名与同一个图标，于是「改一次按钮样式要改五处」。
 *
 * `editor.delete_confirm_hint` 的取词留在共享件内：三个调用点读的是同一个词条（不像版本行那样各读各的
 * key 族），不存在替调用点重指文案的问题；`label`（追加按钮文案）则由调用点翻译后传入。
 *
 * 刻意**不**收 `ParamsEditor` 的删除按钮：它的类串是 `size-6 …`（没有 `flex-shrink-0`，与第二行的
 * 占位块配套），与本件的 `size-6 flex-shrink-0 …` 不是逐字重复，强行合并会改动它的行布局。
 */
export function EntryDeleteButton({ confirming, onClick }: { confirming: boolean; onClick: () => void }) {
  const { t } = useTranslation("workflows");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      title={confirming ? t("editor.delete_confirm_hint") : undefined}
      className={`size-6 flex-shrink-0 ${confirming ? "bg-amber-50 text-red-500" : "text-gray-400"}`}
    >
      <Trash2 size={13} />
    </Button>
  );
}

export function EntryAddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClick} className="gap-1 text-gray-500 text-xs h-7">
      <Plus size={12} /> {label}
    </Button>
  );
}
