import { CircleGauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { formatTokenCount } from "../lib/token-stats";

/**
 * 上下文占用计（Context meter）。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/composer-context-meter.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：命名空间改为包内 `UI_COMPONENTS_NS`（键 `chat.components.chatComposer.context*`）；
 * `@/src/lib/token-stats` 的 `formatTokenCount` 改为包内 `../lib/token-stats`（由消息视图组产出）；
 * 局部 `ContextUsage` 结构类型与渲染结构逐字保留。
 */

interface ContextUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
}

/** 展示协议返回的当前上下文占用，并在 Agent 提供窗口容量时展示比例。 */
export function ComposerContextMeter({ usage }: { usage?: ContextUsage | null }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const total = usage?.totalTokens;
  const limit = usage?.contextWindow;
  const known = typeof total === "number" && Number.isFinite(total) && total >= 0;
  const knownLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;

  if (!known) return null;

  const title = knownLimit
    ? t("chat.components.chatComposer.contextUsed", { count: formatTokenCount(total), limit: formatTokenCount(limit) })
    : t("chat.components.chatComposer.contextUsedUnknownLimit", { count: formatTokenCount(total) });

  return (
    // 计数与图标色取自源 `.chat-composer-context` 及其 `[data-known]` 两支：组件在 `!known` 时直接返回 null，
    // 故 `data-known` 恒存在、图标恒为主题蓝 `#3e75dc`（源的灰支 `#a4afbf` 不可达），此处按生效值直写。
    <span
      className="group inline-flex h-7 shrink-0 items-center gap-1.25 px-1.5 text-3xs text-gray-400"
      data-known
      data-slot="chat-composer-context"
      title={title}
    >
      <CircleGauge className="h-4 w-4 text-blue-500" />
      <span className="hidden group-hover:inline">{t("chat.components.chatComposer.context")}</span>
      <strong className="text-3xs font-medium max-md:hidden">
        {`${formatTokenCount(total)}${knownLimit ? ` / ${formatTokenCount(limit)}` : ""}`}
      </strong>
    </span>
  );
}
