/**
 * ObservationDetail —— 单个 observation 的详情面板。
 *
 * 移植来源：langfuse-lite `components/observation-detail.tsx`。
 *
 * 本次适配（逐条对应原因）：
 * - 对外契约收敛为 `{ observation, onClose, className }`：数据由面板壳给定（详情请求属于壳的职责），
 *   详情本身不做任何取数，因此去掉参考实现的 scores 入参；
 * - 去掉打分（Score）、书签 / 星标、全屏 Dialog 与 trace 级 IO 页签：那是参考产品的其它特性，不是本面板的
 *   契约；详情只保留 Input / Output / Metadata 三个页签，参考实现的 Preview 改为头部下方常驻的摘要段
 *   （组件仍是 `ObservationPreview`，摘要逻辑未改）；
 * - 头部补上成本与 prompt 名：本面板把它们当作一等信息，缺了这两项，成本与提示词版本的排查还得回到列表；
 * - 时长优先用上游给出的 `latency`（秒），缺失时才回落到起止时间差；文案全部走 `t()`
 *   （字典见 `web/i18n/locales/*\/trace-detail.json` 的 `detail` 段）。
 */

import { cn } from "@fenix/ui-components/lib/cn";
import {
  formatClockTime,
  formatCost,
  formatDateTime,
  formatInterval,
  formatSeconds,
  formatTokens,
} from "@fenix/ui-components/lib/format";
import { Button } from "@fenix/ui-components/ui/button";
import { JsonViewer } from "@fenix/ui-components/ui/json-view";
import { Separator } from "@fenix/ui-components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { Clock, Coins, Cpu, FileText, Layers, type LucideIcon, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TRACE_NS } from "../../i18n/namespace";
import type { TraceObservation } from "../../lib/observation-types";
import { ObservationLevelBadge, ObservationTypeBadge } from "../observation-badges";
import { IoViewer } from "./io-viewer";
import { ObservationPreview } from "./observation-preview";

/** 头部统计块：图标 + 标签 + 值。 */
function StatChip({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-2/60 px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-text-muted" />
      <div className="min-w-0 leading-tight">
        <div className="text-3xs uppercase tracking-wider text-text-muted">{label}</div>
        <div className="truncate text-sm font-semibold text-text-primary">{value}</div>
      </div>
    </div>
  );
}

export interface ObservationDetailProps {
  observation: TraceObservation;
  /** 关闭详情（面板壳据此回到调用图）；详情自身不持有选中态。 */
  onClose: () => void;
  className?: string;
}

export function ObservationDetail({ observation, onClose, className }: ObservationDetailProps) {
  const { t } = useTranslation(TRACE_NS);
  const source = observation;

  // EVENT 表示一个时间点，报「时刻」比报一段零长度耗时更贴近事实；其余类型优先用上游 latency。
  const duration =
    source.type === "EVENT"
      ? formatClockTime(source.startTime)
      : source.latency !== null
        ? formatSeconds(source.latency)
        : formatInterval(source.startTime, source.endTime);

  const promptName = source.promptName
    ? source.promptVersion !== null
      ? `${source.promptName} ${t("detail.promptVersion", { version: source.promptVersion })}`
      : source.promptName
    : "—";

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <ObservationTypeBadge type={source.type} />
        <span className="min-w-0 truncate text-base font-semibold text-text-primary">
          {source.name ?? t("detail.unnamed")}
        </span>
        <ObservationLevelBadge level={source.level} />
        <Button variant="ghost" size="icon-sm" className="ms-auto" onClick={onClose} aria-label={t("detail.close")}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <StatChip
              icon={Clock}
              label={source.type === "EVENT" ? t("detail.at") : t("detail.duration")}
              value={duration}
            />
            <StatChip icon={Cpu} label={t("detail.model")} value={source.model ?? "—"} />
            <StatChip
              icon={Layers}
              label={t("detail.tokens")}
              value={
                source.totalTokens > 0
                  ? `${formatTokens(source.promptTokens)} → ${formatTokens(source.completionTokens)} (${formatTokens(source.totalTokens)})`
                  : "—"
              }
            />
            <StatChip icon={Coins} label={t("detail.cost")} value={formatCost(source.totalCost)} />
            <StatChip icon={FileText} label={t("detail.prompt")} value={promptName} />
          </div>

          <div className="space-y-1 text-xs text-text-muted">
            <p>
              {t("detail.start")}: {formatDateTime(source.startTime)}
            </p>
            <p>
              {t("detail.end")}: {formatDateTime(source.endTime)}
            </p>
            <p className="font-mono">
              {t("detail.id")}: {source.id}
            </p>
            {source.statusMessage && (
              <p>
                {t("detail.status")}: {source.statusMessage}
              </p>
            )}
          </div>

          <Separator />

          <section className="space-y-2" aria-label={t("detail.preview")}>
            <h3 className="text-3xs font-semibold uppercase tracking-wider text-text-muted">{t("detail.preview")}</h3>
            <ObservationPreview observation={source} />
          </section>

          <Separator />

          <Tabs defaultValue="input">
            <TabsList>
              <TabsTrigger value="input">{t("detail.tabInput")}</TabsTrigger>
              <TabsTrigger value="output">{t("detail.tabOutput")}</TabsTrigger>
              <TabsTrigger value="metadata">{t("detail.tabMetadata")}</TabsTrigger>
            </TabsList>
            <TabsContent value="input" className="mt-3">
              <IoViewer data={source.input} />
            </TabsContent>
            <TabsContent value="output" className="mt-3">
              <IoViewer data={source.output} />
            </TabsContent>
            <TabsContent value="metadata" className="mt-3">
              <JsonViewer data={source.metadata} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
