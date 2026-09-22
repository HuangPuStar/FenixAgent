import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { cn } from "../lib/cn";
import { Badge } from "../ui/badge";

/**
 * 状态色调：业务只声明语义，具体配色（含 dark 变体）留在组件库。
 *
 * 用「色调」而不是直接给色值，是因为状态词表按业务域分裂（任务日志 success/failed、
 * 工作流 RUNNING/SUCCESS、生产视图 enabled/disabled 各不相同），能共享的只有
 * 「这个词算好消息还是坏消息」这一层判断；色值一旦外露，各业务就会各自演化出不同的绿。
 */
export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/** 色调 → Badge 变体 + 配色类。danger / neutral 直接借用 Badge 自带变体，无需覆盖。 */
const TONE_STYLES: Record<StatusTone, { variant: BadgeVariant; className: string }> = {
  success: { variant: "default", className: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" },
  info: { variant: "default", className: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" },
  warning: { variant: "default", className: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300" },
  danger: { variant: "destructive", className: "" },
  neutral: { variant: "secondary", className: "" },
};

/**
 * 内置状态词表：只收「包内与宿主通用」的状态，业务私有词表经 `toneMap` 注入。
 * 未命中一律按 `neutral` 处理——未知状态是坏消息的假设会让新状态上线即报红。
 */
const BUILT_IN_TONES: Record<string, StatusTone> = {
  enabled: "success",
  configured: "success",
  disabled: "neutral",
  unconfigured: "neutral",
  builtIn: "info",
  custom: "neutral",
};

/** 解析状态色调：`toneMap` 优先于内置词表，都未命中按 `neutral`。 */
export function getStatusTone(status: string, toneMap?: Record<string, StatusTone>): StatusTone {
  return toneMap?.[status] ?? BUILT_IN_TONES[status] ?? "neutral";
}

/** 指示点形态：`dot` 静态、`pulse` 呼吸（进行中），`none` 只出文字。 */
export type StatusIndicator = "none" | "dot" | "pulse";

interface StatusBadgeProps {
  status: string;
  /** 文案覆盖；不给则查 i18n 字典 `statusBadge.<status>`，仍缺则回退状态原文 */
  label?: string;
  /** 色调覆盖，优先于 `toneMap` 与内置词表 */
  tone?: StatusTone;
  /** 业务状态词表 → 色调 */
  toneMap?: Record<string, StatusTone>;
  indicator?: StatusIndicator;
  className?: string;
}

/**
 * 状态徽标：状态字符串 + 可选词表 → 带语义配色的 Badge。
 *
 * 指示点用 `bg-current` 取当前文字色，因此新增色调不需要同步维护第三份色值。
 */
export function StatusBadge({ status, label, tone, toneMap, indicator = "none", className }: StatusBadgeProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const resolvedTone = tone ?? getStatusTone(status, toneMap);
  const style = TONE_STYLES[resolvedTone];
  return (
    <Badge variant={style.variant} data-tone={resolvedTone} className={cn(style.className, className)}>
      {indicator !== "none" && (
        <span
          aria-hidden="true"
          data-slot="status-badge-indicator"
          className={cn("size-1.5 shrink-0 rounded-full bg-current", indicator === "pulse" && "animate-pulse")}
        />
      )}
      {label ?? t(`statusBadge.${status}`, status)}
    </Badge>
  );
}
