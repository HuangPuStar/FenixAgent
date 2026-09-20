// web/src/pages/admin/components/ProviderPayloadDialog.tsx
// Provider 原始返回值查看对话框（实例状态点的落地页）。自原 AdminSandboxPage.tsx 拆出。
//
// 内容是不可信外部结构的原样 JSON，只做缩进展示，不解析字段：展示即诊断用途。

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";

interface ProviderPayloadDialogProps {
  target: { id: string; payload: unknown } | null;
  onOpenChange: (open: boolean) => void;
}

export function ProviderPayloadDialog({ target, onOpenChange }: ProviderPayloadDialogProps) {
  const { t } = useTranslation(SANDBOX_NS);
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("providerPayloadTitle")}</DialogTitle>
        </DialogHeader>
        {/* <pre> 是 generic role，不支持 aria-label；内容由 DialogTitle 命名，无需重复标注。 */}
        <pre className="max-h-[65vh] max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-4 text-xs">
          {JSON.stringify(target?.payload, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
