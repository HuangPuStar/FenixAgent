import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";

interface SystemMessageProps {
  /** 原始 system-reminder 块仅在用户主动查看详情时展示。 */
  rawText: string;
  className?: string;
}

/**
 * 系统消息默认展示弱化胶囊，双击后可检查完整原始内容。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/SystemMessage.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：
 * - `@/components/ui/dialog` → 包内 `../../ui/dialog`，`@/src/lib/utils` 的 `cn` → `../../lib/cn`。
 * - i18n 命名空间从宿主 `NS.COMPONENTS` 改为包内单一命名空间，键加 `chat.components.` 前缀。
 * - 文案、DOM 结构、类名与交互（双击打开详情）逐字保留。
 */
export const SystemMessage = memo(function SystemMessage({ rawText, className }: SystemMessageProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (!rawText) return null;

  return (
    <>
      <div className={cn("flex justify-start", className)}>
        <button
          type="button"
          className="inline-flex min-h-[22px] cursor-pointer items-center rounded-full border border-[#e1e7ef] bg-white px-[10px] py-0.5 text-[#63728a] tracking-[0.04em] [font:700_10px/1.4_ui-monospace,monospace] hover:border-[#c5cfdd] hover:text-[#46566d] focus-visible:border-[#c5cfdd] focus-visible:text-[#46566d]"
          data-slot="chat-system-reminder"
          onDoubleClick={() => setDetailsOpen(true)}
          aria-expanded={detailsOpen}
          aria-haspopup="dialog"
          aria-label={t("chat.components.messageBubble.openSystemMessage")}
        >
          {t("chat.components.messageBubble.systemMessage")}
        </button>
      </div>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-h-[80vh] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("chat.components.messageBubble.systemMessage")}</DialogTitle>
            <DialogDescription>{t("chat.components.messageBubble.systemMessageDescription")}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-xs">
            {rawText}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
});
