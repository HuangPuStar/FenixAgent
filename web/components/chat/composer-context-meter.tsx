import { CircleGauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatTokenCount } from "../../src/lib/token-stats";

interface ContextUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
}

/** 展示协议返回的当前上下文占用，并在 Agent 提供窗口容量时展示比例。 */
export function ComposerContextMeter({ usage }: { usage?: ContextUsage | null }) {
  const { t } = useTranslation("components");
  const total = usage?.totalTokens;
  const limit = usage?.contextWindow;
  const known = typeof total === "number" && Number.isFinite(total);
  const knownLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;
  const title = known
    ? knownLimit
      ? t("chatComposer.contextUsed", { count: formatTokenCount(total), limit: formatTokenCount(limit) })
      : t("chatComposer.contextUsedUnknownLimit", { count: formatTokenCount(total) })
    : t("chatComposer.contextUnknown");
  return (
    <span className="chat-composer-context" data-known={known || undefined} title={title}>
      <CircleGauge />
      <span>{t("chatComposer.context")}</span>
      <strong>{known ? `${formatTokenCount(total)}${knownLimit ? ` / ${formatTokenCount(limit)}` : ""}` : "—"}</strong>
    </span>
  );
}
