import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../src/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

interface SystemMessageProps {
  /** 详细信息（原始 system-reminder 块文本，含标签），hover 时以 tooltip 展示 */
  rawText: string;
  className?: string;
}

/**
 * 系统消息 — 居中弱化样式，外部仅展示"系统消息"标签（内容与正文重复故不再内联展示），
 * hover 时以 tooltip 展示原始 system-reminder 块全文。
 */
export const SystemMessage = memo(function SystemMessage({ rawText, className }: SystemMessageProps) {
  const { t } = useTranslation("components");
  if (!rawText) return null;
  return (
    <div className={cn("flex justify-center", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-1 px-2.5 py-0.5 text-[11px] text-text-secondary select-none">
            {t("messageBubble.systemMessage")}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[420px] font-mono text-[11px] whitespace-pre-wrap break-all">
          {rawText}
        </TooltipContent>
      </Tooltip>
    </div>
  );
});
