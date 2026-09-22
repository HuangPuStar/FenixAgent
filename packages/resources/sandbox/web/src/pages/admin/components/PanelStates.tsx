// web/src/pages/admin/components/PanelStates.tsx
// 管理面板的「首屏加载」与「首屏失败」两个整块占位视图。
//
// 2026-09-22 前端去重：ClusterPanel 与 PoolTree 各写了一份逐字相同的骨架块（`aria-busy` 包裹
// `h-72` 骨架 + sr-only 加载文案），以及一份结构逐字相同的失败块（Card 内 alert 文案 + 提示行 +
// 描边重试按钮）——失败块只有「错误文案 key」与「重试回调的形参名」（onRefresh / onRetry）不同。
//
// 状态语义沿用本包统一约定（详见 PoolTree 文件头）：加载 → role="status"，错误 → role="alert"，
// 成功/失败反馈走 sonner toast。占位块只在**首屏**（无任何数据）时整块替换内容，已有数据时由调用方
// 决定保留列表，因此这里不做「加载中」的局部提示。

import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent } from "@fenix/ui-components/ui/card";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";

/** 首屏加载占位：无数据可展示时撑起面板高度，避免刷新时布局塌陷。 */
export function PanelLoadingState() {
  const { t } = useTranslation(SANDBOX_NS);
  return (
    <div aria-busy="true">
      <Skeleton className="h-72 w-full" />
      <span className="sr-only" role="status">
        {t("states.loading")}
      </span>
    </div>
  );
}

export interface PanelErrorStateProps {
  /** 错误说明文案，由调用方经 i18n 提供——各面板的失败语境不同（如 `t("clusterError")` / `t("error")`）。 */
  message: string;
  /** 重试回调：重新拉取该面板的数据。 */
  onRetry: () => void;
}

/** 首屏失败占位：拿不到任何数据时给出可诊断文案与重试入口。 */
export function PanelErrorState({ message, onRetry }: PanelErrorStateProps) {
  const { t } = useTranslation(SANDBOX_NS);
  return (
    <Card>
      <CardContent className="space-y-3 py-8 text-center">
        <p className="text-sm text-destructive" role="alert">
          {message}
        </p>
        <p className="text-xs text-text-muted">{t("errorHint")}</p>
        <Button variant="outline" onClick={onRetry}>
          {t("states.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}
