import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { HindsightFailure } from "../failure";

/**
 * 记忆页面加载失败的统一呈现（授权失败 / 通用失败）。
 *
 * 为什么抽成组件：页面状态、图谱、实体列表、实体详情、记忆详情共五处调用点，形态相同，而
 * 「授权失败不给重试」是同一条业务判断——散落五份必然各自漂移（`Retry` 对 403 永远无效，
 * 只会在界面上制造「点了没用」的死循环）。
 *
 * 2026-09-22 前端去重：内部改用库的 `EmptyState`（`tone="danger"` 由它管配色，含 dark 变体）。
 * 迁移前这里是「图标 + 标题 + 说明 + 可选按钮」的一段裸片段，`role="alert"` 与居中留白都由各调用方
 * 复写（五处各写一遍同样的 `flex flex-col items-center justify-center ... text-center`），
 * 去重后块自身就是完整的状态块：`role="alert"` 内聚在此，调用方只用 `className` 表达各自的外间距。
 */
export interface HindsightFailureNoticeProps {
  failure: HindsightFailure;
  /** 通用失败分支的标题键；授权分支固定用 `errors.forbiddenTitle`，不读该键。 */
  titleKey?: string;
  /** 通用失败分支的重试入口与按钮键；授权分支不渲染按钮。 */
  onRetry?: () => void;
  retryKey?: string;
  /** 状态块的外间距（各调用点留白不同）；不传时用 `EmptyState` 的默认 `py-10`。 */
  className?: string;
}

export function HindsightFailureNotice({
  failure,
  titleKey,
  onRetry,
  retryKey,
  className,
}: HindsightFailureNoticeProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const forbidden = failure.kind === "forbidden";
  const resolvedTitleKey = forbidden ? "errors.forbiddenTitle" : titleKey;

  return (
    <EmptyState
      tone="danger"
      role="alert"
      className={className}
      icon={<AlertCircle />}
      title={resolvedTitleKey ? t(resolvedTitleKey) : null}
      description={forbidden ? t("errors.forbiddenHint") : failure.detail}
      action={
        !forbidden && onRetry && retryKey
          ? { label: t(retryKey), onClick: onRetry, icon: <RefreshCw className="size-4" /> }
          : undefined
      }
    />
  );
}
