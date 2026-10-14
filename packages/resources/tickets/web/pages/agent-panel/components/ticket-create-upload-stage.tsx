/**
 * 新建弹窗的第二阶段：工单已创建，把暂存的附件移交给上传队列，全部终结后进入工单。
 *
 * 为什么单独一个阶段组件而不是留在弹窗主体里：上传队列的坐标（projectId / number）必须在挂载时就已确定
 * （见 `useTicketUploadHandoff` 的注释）。用独立阶段承载上传，hook 的一生只有一个坐标，不必处理坐标切换
 * ——hook 在 `[projectId, number]` 变化时会取消在途并清空队列，那正是「换工单」的正确语义，却会成为
 * 「创建前后同组件」的实现负担。
 *
 * 上传期间弹窗不可关闭（无关闭按钮，ESC 与遮罩点击也不生效）：工单已经创建，此刻用户唯一合理的去向是
 * 进入它；允许关闭会把「附件还在传」变成一次静默中断。失败项不阻塞出口——「前往工单」放弃剩余未上传的
 * 附件（已上传的仍在工单上），逐项的「重试 / 移除」也可用。
 */

import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { useTranslation } from "react-i18next";
import { useTicketUploadHandoff } from "../../../hooks/use-ticket-create-attachments";
import { TICKETS_NS } from "../../../i18n/namespace";
import { TicketAttachmentUploadList } from "./ticket-attachment-section";

export interface TicketCreateUploadStageProps {
  projectId: string;
  /** 已创建工单的工单号：上传请求的坐标。 */
  number: string;
  /** 已改名的暂存文件（生命周期内引用不变）。 */
  files: readonly File[];
  /** 全部任务终结时回调：由弹窗关闭自身并进入工单。 */
  onFinished: () => void;
}

export function TicketCreateUploadStage({ files, number, onFinished, projectId }: TicketCreateUploadStageProps) {
  const { t, i18n } = useTranslation(TICKETS_NS);
  const handoff = useTicketUploadHandoff({ files, number, onFinished, projectId });
  /** 只剩失败项、没有在途任务：此时「前往工单」不会中止任何传输，出口才该出现。 */
  const settledWithFailures = handoff.uploads.length > 0 && handoff.uploads.every((task) => task.status === "failed");

  return (
    <Dialog open>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-xl"
        disableEscapeClose
        disableOverlayClose
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("create.uploadTitle")}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <p className="text-xs text-text-dim">{t("create.uploadHint", { total: files.length })}</p>
          <div className="mt-3">
            <TicketAttachmentUploadList
              locale={i18n.language}
              onCancel={handoff.cancelUpload}
              onRemove={handoff.removeUpload}
              onRetry={handoff.retryUpload}
              uploads={handoff.uploads}
            />
          </div>
        </div>
        {settledWithFailures ? (
          <DialogFooter className="shrink-0 border-t bg-background pt-4">
            <Button
              onClick={() => {
                // 放弃剩余未上传的附件：全部移除后完成判定自会进入工单，不在这里另开一条跳转路径。
                for (const task of handoff.uploads) handoff.removeUpload(task.id);
              }}
              type="button"
              variant="outline"
            >
              {t("create.goToTicket")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
