import { memo } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../src/i18n";
import { cn } from "../../src/lib/utils";

interface SystemMessageProps {
  /** 原始 system-reminder 块仅用于判空，内容不在界面暴露。 */
  rawText: string;
  className?: string;
}

/**
 * 系统消息仅展示弱化胶囊，不展开内部注入内容。
 */
export const SystemMessage = memo(function SystemMessage({ rawText, className }: SystemMessageProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  if (!rawText) return null;

  return (
    <div className={cn("flex justify-start", className)}>
      <span className="chat-system-reminder">{t("messageBubble.systemMessage")}</span>
    </div>
  );
});
