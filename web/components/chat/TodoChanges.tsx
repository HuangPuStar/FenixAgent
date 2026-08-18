import { CheckCircle, Circle, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TodoChange, TodoChangeKind } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";

interface TodoChangesProps {
  changes: TodoChange[];
}

const CHANGE_STYLES: Record<
  TodoChangeKind,
  { Icon: typeof Circle; iconClassName: string; labelClassName: string; itemClassName: string }
> = {
  added: {
    Icon: Plus,
    iconClassName: "text-violet-600 dark:text-violet-400",
    labelClassName: "text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-950/60",
    itemClassName: "text-text-secondary",
  },
  removed: {
    Icon: Trash2,
    iconClassName: "text-text-muted",
    labelClassName: "text-text-muted bg-surface-2",
    itemClassName: "text-text-muted line-through",
  },
  pending: {
    Icon: Circle,
    iconClassName: "text-text-muted",
    labelClassName: "text-text-muted bg-surface-2",
    itemClassName: "text-text-secondary",
  },
  in_progress: {
    Icon: Circle,
    iconClassName: "text-status-running",
    labelClassName: "text-status-running bg-status-running/10",
    itemClassName: "text-text-primary font-medium",
  },
  completed: {
    Icon: CheckCircle,
    iconClassName: "text-status-active",
    labelClassName: "text-status-active bg-status-active/10",
    itemClassName: "text-text-muted line-through",
  },
  updated: {
    Icon: Pencil,
    iconClassName: "text-text-secondary",
    labelClassName: "text-text-secondary bg-surface-2",
    itemClassName: "text-text-secondary",
  },
};

/** TodoWrite 工具卡片的增量列表；只展示本次调用相较上一轮变动的待办。 */
export function TodoChanges({ changes }: TodoChangesProps) {
  const { t } = useTranslation("components");
  if (changes.length === 0) return null;

  return (
    <div className="mx-3 mb-2.5 mt-1 border-t border-violet-200/60 pt-1.5 dark:border-violet-900/40">
      {changes.map((change) => {
        const { Icon, iconClassName, labelClassName, itemClassName } = CHANGE_STYLES[change.kind];
        const text =
          change.kind === "in_progress" ? (change.todo.activeForm ?? change.todo.content) : change.todo.content;
        return (
          <div key={change.id} className="flex items-start gap-2 py-1">
            <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", iconClassName)} />
            <span className={cn("min-w-0 flex-1 text-[11px] leading-relaxed", itemClassName)}>{text}</span>
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px]", labelClassName)}>
              {t(`todoChanges.${change.kind}`)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
