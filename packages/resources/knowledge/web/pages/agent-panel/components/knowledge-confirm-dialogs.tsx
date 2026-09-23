// web/pages/agent-panel/components/knowledge-confirm-dialogs.tsx
// 知识库页的**危险操作确认**族（四处）：删除知识库、删除单个资源、同名文件覆盖上传、重新解析。
// 纯受控——确认动作与各自的挂起状态都在域 hook 里（`use-knowledge-base-catalog` /
// `use-knowledge-base-detail`），这里只画弹窗并把按钮接到 `onConfirm`。
//
// 从 `AgentKnowledgeBasesPage.tsx` 拆出（§4.7）：四处确认此前散在页面中段的 90 行 JSX 里，
// 与「重新解析带一个删除旧分块的勾选」这类交互细节混在同一文件；按名字分组后调用方一行一组。

import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fenix/ui-components/ui/alert-dialog";
import { Button } from "@fenix/ui-components/ui/button";
import { Checkbox } from "@fenix/ui-components/ui/checkbox";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useTranslation } from "react-i18next";
import type { KnowledgeBaseInfo, KnowledgeResourceInfo } from "../../../types/knowledge";

interface KnowledgeConfirmDialogsProps {
  /** 删除知识库：列表行与详情头部共用同一处确认 */
  deleteKnowledgeBase: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    target: KnowledgeBaseInfo | null;
    onConfirm: () => void;
  };
  /** 删除单个资源 */
  deleteResource: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    target: { name: string } | null;
    onConfirm: () => void;
  };
  /** 同名文件覆盖上传：列出这次命中的同名文件 */
  overwriteUpload: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    names: string[];
    onConfirm: () => void;
  };
  /** 重新解析：带「删除已有分块」勾选，勾选态由调用方持有（每次打开都复位） */
  reparse: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    target: KnowledgeResourceInfo | null;
    deleteOld: boolean;
    onDeleteOldChange: (value: boolean) => void;
    onConfirm: () => void;
  };
}

export function KnowledgeConfirmDialogs(props: KnowledgeConfirmDialogsProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);

  return (
    <>
      <ConfirmDialog
        open={props.deleteKnowledgeBase.open}
        onOpenChange={props.deleteKnowledgeBase.onOpenChange}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription", { name: props.deleteKnowledgeBase.target?.name ?? "" })}
        variant="destructive"
        onConfirm={props.deleteKnowledgeBase.onConfirm}
      />

      {/* 资源删除确认 */}
      <ConfirmDialog
        open={props.deleteResource.open}
        onOpenChange={props.deleteResource.onOpenChange}
        title={t("confirm.deleteResourceTitle")}
        description={t("confirm.deleteResourceDescription", { name: props.deleteResource.target?.name ?? "" })}
        variant="destructive"
        onConfirm={props.deleteResource.onConfirm}
      />

      {/* 同名文件覆盖确认 */}
      <ConfirmDialog
        open={props.overwriteUpload.open}
        onOpenChange={props.overwriteUpload.onOpenChange}
        title="覆盖同名文件"
        description={`以下文件已存在，上传将覆盖原有文件：\n${props.overwriteUpload.names.join("、")}`}
        onConfirm={props.overwriteUpload.onConfirm}
      />

      {/* 重新解析确认：checkbox 选择是否删除已有分块 */}
      <AlertDialog open={props.reparse.open} onOpenChange={props.reparse.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reparse.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("reparse.confirmDescription", { name: props.reparse.target?.sourceName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2 py-2">
            <Checkbox
              id="reparse-delete"
              checked={props.reparse.deleteOld}
              onCheckedChange={(v) => props.reparse.onDeleteOldChange(!!v)}
            />
            <label htmlFor="reparse-delete" className="text-xs cursor-pointer">
              {t("reparse.deleteCheckbox")}
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => props.reparse.onDeleteOldChange(false)}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <Button onClick={props.reparse.onConfirm}>{t("reparse.startBtn")}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
