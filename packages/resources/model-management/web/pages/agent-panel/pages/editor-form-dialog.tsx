import { Button } from "@fenix/ui-components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fenix/ui-components/ui/dialog";
import { useTranslation } from "react-i18next";
import { MODELS_NS } from "../../../i18n/namespace";

/**
 * 两个编辑弹窗（Provider / 模型）共用的外壳。
 *
 * 这两处此前逐字同构：`Dialog` + `DialogContent.flex max-h-[88vh] flex-col sm:max-w-2xl` + `DialogHeader`
 * + `form.flex min-h-0 flex-1 flex-col` + `div.grid min-h-0 gap-4 overflow-y-auto pr-1 sm:grid-cols-2`
 * + 同一个 `DialogFooter`（取消 + 保存，`readOnly` 时不出提交按钮）。收在这里之后，两个弹窗只留各自的
 * 字段与提交逻辑——改外壳（高度上限、栅格、页脚）不必再同步两个函数。
 *
 * `description` 只有 Provider 弹窗有（模型弹窗不写说明），故为可选：不传就不渲染 `DialogDescription`。
 *
 * 从 `agent-models-dialogs.tsx` 拆出（§4.7）：两个真实用例分别在 `provider-editor-dialog.tsx`
 * 与 `agent-models-dialogs.tsx`，外壳不属于其中任何一个。
 */
export function EditorFormDialog({
  open,
  title,
  description,
  readOnly,
  saving,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  readOnly: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(MODELS_NS);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
          <div className="grid min-h-0 gap-4 overflow-y-auto pr-1 sm:grid-cols-2">{children}</div>
          <DialogFooter className="mt-4 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("actions.close")}
            </Button>
            {!readOnly && (
              <Button type="submit" disabled={saving}>
                {saving ? t("actions.saving") : t("actions.save")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
