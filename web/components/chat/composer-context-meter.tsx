import { CircleGauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatTokenCount } from "../../src/lib/token-stats";

interface ContextUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** 只展示协议返回的真实用量；上下文上限未知时不计算伪百分比。 */
export function ComposerContextMeter({ usage }: { usage?: ContextUsage | null }) {
  const { t } = useTranslation("components");
  const total = usage?.totalTokens;
  const known = typeof total === "number" && Number.isFinite(total);
  const title = known
    ? t("chatComposer.contextUsedUnknownLimit", { count: formatTokenCount(total) })
    : t("chatComposer.contextUnknown");
  return (
    <span className="chat-composer-context" data-known={known || undefined} title={title}>
      <CircleGauge />
      <span>{t("chatComposer.context")}</span>
      <strong>{known ? formatTokenCount(total) : "—"}</strong>
    </span>
  );
}
