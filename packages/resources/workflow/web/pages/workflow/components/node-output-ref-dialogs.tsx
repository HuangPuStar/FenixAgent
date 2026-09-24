import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { useTranslation } from "react-i18next";
import type { OutputDeleteDialogState, OutputRenameDialogState } from "./use-node-output-ref-guard";

/**
 * 输出字段改名 / 删除的两个确认弹窗（渲染层）。
 *
 * 状态与 Promise 编排在 `use-node-output-ref-guard.ts`。两个弹窗同处一文件，是因为它们共用
 * 一套外形（`maxWidth: 400` 的对话框 + 一行取消 / 确认按钮）且永远成对出现——用户在任一时点
 * 只会看到其中一个，改样式时两处要一起看。
 *
 * 挂在 `NodeConfigCard` 的根节点上（而不是某个字段里）：弹窗的存活要独立于字段的重渲，
 * 也与卡片根部的展开编辑弹窗同级。
 */
export function NodeOutputRefDialogs({
  renameDialog,
  deleteDialog,
  onRenameCancel,
  onRenameConfirm,
  onDeleteCancel,
  onDeleteConfirm,
}: {
  renameDialog: OutputRenameDialogState | null;
  deleteDialog: OutputDeleteDialogState | null;
  onRenameCancel: () => void;
  onRenameConfirm: () => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
}) {
  const { t } = useTranslation("workflows");

  return (
    <>
      {/* 输出字段改名确认 Dialog */}
      <Dialog
        open={renameDialog !== null}
        onOpenChange={(open) => {
          if (!open) onRenameCancel();
        }}
      >
        <DialogContent style={{ maxWidth: 400 }}>
          <DialogHeader>
            <DialogTitle>{t("editor.rename_output_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            {t("editor.rename_output_desc", {
              oldKey: renameDialog?.oldKey ?? "",
              newKey: renameDialog?.newKey ?? "",
              count: renameDialog?.affectedCount ?? 0,
            })}
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={onRenameCancel}>
              {t("editor.cancel")}
            </Button>
            <Button size="sm" onClick={onRenameConfirm}>
              {t("editor.confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 输出字段删除确认 Dialog */}
      <Dialog
        open={deleteDialog !== null}
        onOpenChange={(open) => {
          if (!open) onDeleteCancel();
        }}
      >
        <DialogContent style={{ maxWidth: 400 }}>
          <DialogHeader>
            <DialogTitle>{t("editor.delete_output_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            {t("editor.delete_output_desc", {
              key: deleteDialog?.key ?? "",
              count: deleteDialog?.affectedCount ?? 0,
            })}
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={onDeleteCancel}>
              {t("editor.cancel")}
            </Button>
            <Button size="sm" variant="destructive" onClick={onDeleteConfirm}>
              {t("editor.delete_output_confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
