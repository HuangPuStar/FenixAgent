import { cn } from "@fenix/ui-components/lib/cn";
import { Badge } from "@fenix/ui-components/ui/badge";
import {
  Bot,
  CircleDot,
  Fan,
  Layers3,
  Link as LinkIcon,
  ListTree,
  type LucideIcon,
  MoveHorizontal,
  Search,
  ShieldCheck,
  WandSparkles,
  Wrench,
} from "lucide-react";

/**
 * observation 类型与级别的角标（图、列表与详情共用）。
 *
 * 配色沿用上游控制台的既有语义（生成品红 / 工具橙 / Agent 紫 / Span 蓝 / 事件绿……）：同一份 trace 在两个
 * 界面里应当是同一套颜色，用户不必重新学习。图标全部取 `lucide-react`（仓库既有依赖）。
 *
 * 类型是**开放集合**：上游加了新类型时回退到中性样式，而不是让角标整块消失——未知类型不该让面板不可用。
 */

interface TypeStyle {
  icon: LucideIcon;
  text: string;
  badge: string;
}

const TYPE_STYLES: Record<string, TypeStyle> = {
  SPAN: { icon: MoveHorizontal, text: "text-blue-600 dark:text-blue-400", badge: "border-blue-500/30 bg-blue-500/10" },
  EVENT: {
    icon: CircleDot,
    text: "text-green-600 dark:text-green-400",
    badge: "border-green-500/30 bg-green-500/10",
  },
  GENERATION: {
    icon: Fan,
    text: "text-fuchsia-600 dark:text-fuchsia-400",
    badge: "border-fuchsia-500/30 bg-fuchsia-500/10",
  },
  AGENT: {
    icon: Bot,
    text: "text-purple-600 dark:text-purple-400",
    badge: "border-purple-500/30 bg-purple-500/10",
  },
  TOOL: {
    icon: Wrench,
    text: "text-orange-600 dark:text-orange-400",
    badge: "border-orange-500/30 bg-orange-500/10",
  },
  CHAIN: { icon: LinkIcon, text: "text-pink-600 dark:text-pink-400", badge: "border-pink-500/30 bg-pink-500/10" },
  RETRIEVER: {
    icon: Search,
    text: "text-teal-600 dark:text-teal-400",
    badge: "border-teal-500/30 bg-teal-500/10",
  },
  EVALUATOR: {
    icon: WandSparkles,
    text: "text-indigo-600 dark:text-indigo-400",
    badge: "border-indigo-500/30 bg-indigo-500/10",
  },
  EMBEDDING: {
    icon: Layers3,
    text: "text-amber-600 dark:text-amber-500",
    badge: "border-amber-500/30 bg-amber-500/10",
  },
  GUARDRAIL: {
    icon: ShieldCheck,
    text: "text-red-600 dark:text-red-400",
    badge: "border-red-500/30 bg-red-500/10",
  },
};

const FALLBACK_STYLE: TypeStyle = {
  icon: ListTree,
  text: "text-text-muted",
  badge: "border-border-subtle bg-surface-2",
};

/** 取类型的配色与图标；未登记的类型回退中性样式。 */
export function observationTypeStyle(type: string): TypeStyle {
  return TYPE_STYLES[type] ?? FALLBACK_STYLE;
}

/** 带图标与类型名的彩色描边角标。 */
export function ObservationTypeBadge({ type, className }: { type: string; className?: string }) {
  const { icon: Icon, text, badge } = observationTypeStyle(type);
  return (
    <Badge variant="outline" className={cn("gap-1 px-1.5 font-medium", badge, text, className)}>
      <Icon className="size-3" />
      {type}
    </Badge>
  );
}

/** 只有图标的类型标记（图的行首与树形结构里空间紧张处使用）。 */
export function ObservationTypeIcon({ type, className }: { type: string; className?: string }) {
  const { icon: Icon, text } = observationTypeStyle(type);
  return <Icon className={cn("size-3.5 shrink-0", text, className)} />;
}

/** 级别角标：ERROR / WARNING 用状态色，其余中性；null 用占位符。 */
export function ObservationLevelBadge({ level }: { level: string | null }) {
  if (!level) return <span className="text-text-dim">—</span>;
  const tone =
    level === "ERROR"
      ? "border-status-error/30 bg-status-error/10 text-status-error"
      : level === "WARNING"
        ? "border-status-warning/30 bg-status-warning/10 text-status-warning"
        : level === "DEBUG"
          ? "border-border-subtle bg-surface-2 text-text-muted"
          : "border-border-subtle bg-surface-2 text-text-secondary";
  return (
    <Badge variant="outline" className={tone}>
      {level}
    </Badge>
  );
}
