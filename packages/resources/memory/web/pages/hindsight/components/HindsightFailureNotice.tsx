import { Button } from "@fenix/ui-components/ui/button";
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
 * 只负责失败块内部内容：`role="alert"` 与居中留白留在各调用方的容器上，与既有 DOM 结构一致，
 * 避免为了统一而改动各页面已验证的布局。
 */
export interface HindsightFailureNoticeProps {
  failure: HindsightFailure;
  /** 通用失败分支的标题键；授权分支固定用 `errors.forbiddenTitle`，不读该键。 */
  titleKey?: string;
  /** 通用失败分支的重试入口与按钮键；授权分支不渲染按钮。 */
  onRetry?: () => void;
  retryKey?: string;
}

export function HindsightFailureNotice({ failure, titleKey, onRetry, retryKey }: HindsightFailureNoticeProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const forbidden = failure.kind === "forbidden";
  const resolvedTitleKey = forbidden ? "errors.forbiddenTitle" : titleKey;

  return (
    <>
      <AlertCircle className="size-8 text-destructive" />
      <div>
        <p className="text-sm font-medium">{resolvedTitleKey ? t(resolvedTitleKey) : null}</p>
        <p className="mt-1 text-xs text-muted-foreground">{forbidden ? t("errors.forbiddenHint") : failure.detail}</p>
      </div>
      {!forbidden && onRetry && retryKey && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {t(retryKey)}
        </Button>
      )}
    </>
  );
}
