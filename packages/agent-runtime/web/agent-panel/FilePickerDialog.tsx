/**
 * 会话输入区的取件入口：把 `FilePickerPanel` 包进 Dialog，并注入本包的目录列表与上传实现。
 *
 * 归属（台账 `ce-standards-todo.md` D1）：会话输入区的取件入口是 chat 域的一部分，随聊天容器簇从
 * `apps/web/src/pages/agent-panel/` 归位本包（原注释即预告「聊天容器簇整体迁出宿主时本文件随簇走」）。
 * 面板壳 `FilePickerPanel` 仍在 `@fenix/ui-components/chat/shell/FilePickerPanel`——它只收注入的
 * `listDir` / `uploadFiles`，不持网络依赖；`envId` 由面板宿主（`ChatPanel`）给出。
 *
 * 两处纯化改动：
 * - `FileInfo` 改从 `@fenix/ui-components/chat/shell/FilePickerPanel` 取（该包已逐字持有同一形状的类型，
 *   包内不再反向引用宿主 `apps/web/src/types`）；
 * - 文案键 `filePicker.title` 随实现迁入本包字典（`AGENT_CHAT_NS`），宿主 `components` 字典删除该键。
 */

import { fsApi, uploadChatFiles } from "@fenix/resource-machine/web";
import { type FileInfo, FilePickerPanel } from "@fenix/ui-components/chat/shell/FilePickerPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useTranslation } from "react-i18next";
import { AGENT_CHAT_NS } from "../i18n/namespace";

interface FilePickerDialogProps {
  open: boolean;
  envId: string;
  onClose: () => void;
  onSelect: (file: FileInfo) => void;
}

export function FilePickerDialog({ open, envId, onClose, onSelect }: FilePickerDialogProps) {
  const { t } = useTranslation(AGENT_CHAT_NS);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-lg rounded-2xl border-border bg-surface-1 p-0 shadow-2xl overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="font-display text-lg font-semibold text-text-primary">
            {t("filePicker.title")}
          </DialogTitle>
        </DialogHeader>
        {/* 面板已迁 `@fenix/ui-components/chat/shell/FilePickerPanel`（§1.6 T6b）：面板本身不持有
            envId 与 API 客户端，目录列表与上传由本对话框注入（fs 客户端与上传实现是 machine 包的公开出口）。 */}
        <FilePickerPanel
          listDir={(dirPath) => unwrap(fsApi.listDir(envId, dirPath || undefined))}
          uploadFiles={(files) => uploadChatFiles(envId, files)}
          onSelect={onSelect}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
