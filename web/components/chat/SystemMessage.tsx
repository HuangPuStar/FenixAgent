import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../src/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface SystemMessageProps {
  /** 详细信息（原始 system-reminder 块文本，含标签），双击标签后以 Popover 展示 */
  rawText: string;
  className?: string;
}

/**
 * 系统消息 — 居中弱化样式，默认仅展示标签；双击标签后以不改变消息流布局的 Popover 展示原始内容。
 */
export const SystemMessage = memo(function SystemMessage({ rawText, className }: SystemMessageProps) {
  const { t } = useTranslation("components");
  const [open, setOpen] = useState(false);

  if (!rawText) return null;

  return (
    <div className={cn("flex justify-center", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border-subtle bg-surface-1 px-2.5 py-0.5 text-[11px] text-text-secondary select-none"
            onClick={(event) => event.preventDefault()}
            onDoubleClick={() => setOpen((value) => !value)}
          >
            {t("messageBubble.systemMessage")}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[420px] max-w-[calc(100vw-2rem)] p-3">
          <pre className="max-h-80 overflow-auto font-mono text-[11px] text-text-secondary whitespace-pre-wrap break-all">
            {rawText}
          </pre>
        </PopoverContent>
      </Popover>
    </div>
  );
});
