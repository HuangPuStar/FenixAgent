import { Button } from "@fenix/ui-components/ui/button";
import { Label } from "@fenix/ui-components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useTranslation } from "react-i18next";
import type { LinkStats, RecencyBasis, ViewMode } from "./data-view-model";

/**
 * 图谱视图右侧的控制面板：视图标题、近期颜色基准、四个链接类型开关，以及当前的节点 / 连线计数。
 *
 * 从 `DataView` 抽出：它与图谱怎么画无关，只读统计与开关状态，和主视图的三态、表格、时间线是并列的
 * 一块。开关计数与开关动作都由 `DataView` 提供——过滤发生在取数派生层（`use-data-view-data.ts`），
 * 面板只负责显示当前值并请求切换。
 */
export interface DataViewControlPanelProps {
  viewMode: ViewMode;
  recencyBasis: RecencyBasis;
  onRecencyBasisChange: (basis: RecencyBasis) => void;
  linkStats: LinkStats;
  onToggleLinkType: (type: string) => void;
  nodeCount: number;
  linkCount: number;
}

export function DataViewControlPanel({
  viewMode,
  recencyBasis,
  onRecencyBasisChange,
  linkStats,
  onToggleLinkType,
  nodeCount,
  linkCount,
}: DataViewControlPanelProps) {
  const { t } = useTranslation(NS.HINDSIGHT);

  return (
    <div className="space-y-4 p-4">
      <h3 className="text-sm font-semibold text-foreground">
        {viewMode === "graph" ? t("dataView.graphTitle") : t("dataView.constellationViewTitle")}
      </h3>
      {viewMode === "constellation" && (
        <>
          <p className="text-xs text-muted-foreground">{t("dataView.constellationViewDescription")}</p>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">{t("dataView.colorBy")}</Label>
            <Select value={recencyBasis} onValueChange={(value) => onRecencyBasisChange(value as RecencyBasis)}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mentioned_at">{t("dataView.mentioned")}</SelectItem>
                <SelectItem value="occurred_start">{t("dataView.occurredStart")}</SelectItem>
                <SelectItem value="occurred_end">{t("dataView.occurredEnd")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t("dataView.linkTypes")}</p>
        {(["semantic", "temporal", "entity", "causal"] as const).map((type) => (
          <Button
            key={type}
            variant="ghost"
            size="sm"
            onClick={() => onToggleLinkType(type)}
            className="w-full justify-between"
          >
            {t(`dataView.${type}`)}
            <span className="font-mono">{linkStats[type]}</span>
          </Button>
        ))}
      </div>
      <div className="text-xs text-muted-foreground">
        {t("dataView.nodes")}: {nodeCount} · {t("dataView.links")}: {linkCount}
      </div>
    </div>
  );
}
