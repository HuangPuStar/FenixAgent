// web/components/chat/PeriTaskViewCard.tsx
// 单个 Peri Task 的紧凑展示卡片（切片 2）。
//
// 展示语义：
// - status → 图标 + 状态徽标：running 显示 spinner（进度指示），终态为静态图标；
// - kind/subtype 徽标：subagent / background × agent / shell / workflow；
//   未知 subtype（taskSubtype=null，如 Subagent 事件无 wire subtype）只显示 kind
//   徽标——"未知类型"以通用徽标呈现，不渲染错误文本；
// - detailAvailability === "unavailable" 时不提供任何可点击详情入口；preview 的
//   有界 summary 已随投影同步到 Doc，直接在卡片内展示，本切片不发 Detail 请求
//   （规格 Slice 3：真实 Detail loader 确认前，UI 只展示 summary 并标注摘要属性）；
// - React.memo：比较器依赖 task 引用——调用方 selector 保证内容未变时引用稳定
//   （use-task-views），内容变更必然生成新对象，比较器无需深比较。

import type { PeriTaskStatus, PeriTaskViewProjection } from "@fenix/chat-channel";
import { Ban, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../src/lib/utils";
import { Badge } from "../ui/badge";

interface PeriTaskViewCardProps {
  task: PeriTaskViewProjection;
  onOpenDetail?: (task: PeriTaskViewProjection) => void;
}

/** status → 图标与配色（running 图标带旋转动画，作为进度指示） */
const STATUS_META: Record<PeriTaskStatus, { icon: typeof Loader2; tone: string; spin?: boolean }> = {
  running: { icon: Loader2, tone: "text-status-running", spin: true },
  completed: { icon: CheckCircle2, tone: "text-status-active" },
  failed: { icon: XCircle, tone: "text-destructive" },
  cancelled: { icon: Ban, tone: "text-text-muted" },
};

/** summary 有界文本的展示截断：多行省略，不做二次长度计算（后端已按 code point 截断） */
const SUMMARY_CLASS =
  "mt-1 text-[11px] leading-relaxed text-text-secondary line-clamp-2 break-words whitespace-pre-wrap";

export const PeriTaskViewCard = memo(function PeriTaskViewCard({ task, onOpenDetail }: PeriTaskViewCardProps) {
  const { t } = useTranslation("components");
  const meta = STATUS_META[task.status] ?? STATUS_META.running;
  const StatusIcon = meta.icon;

  return (
    <li className="flex items-start gap-2.5 py-1.5">
      {/* 状态图标：纯装饰（aria-hidden），可感知状态由文本徽标承担——
          running 徽标文本为「Running」，屏幕阅读器无需依赖图标动画 */}
      <span className={cn("mt-0.5 flex-shrink-0", meta.tone)} aria-hidden="true">
        <StatusIcon className={cn("h-3.5 w-3.5", meta.spin && "animate-spin")} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium text-text-primary break-words">
            {task.title || t("periTask.unknownTitle")}
          </span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {task.isBackground ? t("periTask.kindBackground") : t("periTask.kindSubagent")}
          </Badge>
          {/* 未知 subtype（taskSubtype=null）不渲染徽标：通用 kind 徽标即"未知类型"状态 */}
          {task.taskSubtype && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {t(`periTask.subtype.${task.taskSubtype}`)}
            </Badge>
          )}
          <Badge
            variant={task.status === "failed" ? "destructive" : "outline"}
            className={cn("px-1.5 py-0 text-[10px]", task.status === "running" && "text-status-running")}
          >
            {t(`periTask.status.${task.status}`)}
          </Badge>
        </div>

        {/* 有界摘要：Subagent 为 stopped result、Background 为 output_preview 的脱敏截断。
            detailAvailability 为 preview 时即 UI 可提供的全部信息（规格 Slice 3：
            来源只提供预览，不虚构完整 Detail）；unavailable 时不展示详情入口 */}
        {task.summary ? <p className={SUMMARY_CLASS}>{task.summary}</p> : null}
        {task.detailAvailability !== "unavailable" && (task.summary || task.detailAvailability === "expired") ? (
          <div className="mt-1 flex items-center gap-2">
            {task.detailAvailability === "preview" ? (
              <p className="text-[10px] text-text-dim">{t("periTask.previewOnly")}</p>
            ) : null}
            {onOpenDetail ? (
              <button
                type="button"
                className="text-[10px] font-medium text-primary hover:underline"
                onClick={() => onOpenDetail(task)}
              >
                {t("periTask.viewDetail")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
});
