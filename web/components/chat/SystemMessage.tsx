import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../src/i18n";
import { cn } from "../../src/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

interface SystemMessageProps {
  /** 原始 system-reminder 块仅在用户主动查看详情时展示。 */
  rawText: string;
  className?: string;
}

/**
 * 系统消息默认展示弱化胶囊，双击后可检查完整原始内容。
 */
export const SystemMessage = memo(function SystemMessage({ rawText, className }: SystemMessageProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (!rawText) return null;

  return (
    <>
      <div className={cn("flex justify-start", className)}>
        <button
          type="button"
          className="chat-system-reminder"
          onDoubleClick={() => setDetailsOpen(true)}
          aria-expanded={detailsOpen}
          aria-haspopup="dialog"
          aria-label={t("messageBubble.openSystemMessage")}
        >
          {t("messageBubble.systemMessage")}
        </button>
      </div>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-h-[80vh] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("messageBubble.systemMessage")}</DialogTitle>
            <DialogDescription>{t("messageBubble.systemMessageDescription")}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-xs">
            {rawText}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
});
