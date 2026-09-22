/**
 * TodoWrite 工具卡片的增量列表：只展示本次调用相较上一轮变动的待办。
 *
 * 来源：`packages/agent-runtime/web/components/chat/TodoChanges.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除） 逐字复制。
 * 纯化改动点：
 * - `cn` 改从包内 `../../lib/cn` 导入；色值与样式表逐字保留。
 * - 去掉每条待办右侧的变更标签（源实现为带底色的 badge）：变更语义已由左侧图标与文案样式表达，
 *   右侧标签属重复信息。随之移除 `CHANGE_STYLES` 的 `labelClassName`，以及两个语言包里仅此处
 *   使用的 `chat.components.todoChanges.*` 文案（组件内已无文案，故不再订阅 i18n）。
 */

import { CheckCircle, Circle, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import type { TodoChange, TodoChangeKind } from "../types";

interface TodoChangesProps {
  changes: TodoChange[];
}

const CHANGE_STYLES: Record<TodoChangeKind, { Icon: typeof Circle; iconClassName: string; itemClassName: string }> = {
  added: {
    Icon: Plus,
    iconClassName: "text-violet-600 dark:text-violet-400",
    itemClassName: "text-text-secondary",
  },
  removed: {
    Icon: Trash2,
    iconClassName: "text-text-muted",
    itemClassName: "text-text-muted line-through",
  },
  pending: {
    Icon: Circle,
    iconClassName: "text-text-muted",
    itemClassName: "text-text-secondary",
  },
  in_progress: {
    Icon: Circle,
    iconClassName: "text-status-running",
    itemClassName: "text-text-primary font-medium",
  },
  completed: {
    Icon: CheckCircle,
    iconClassName: "text-status-active",
    itemClassName: "text-text-muted line-through",
  },
  updated: {
    Icon: Pencil,
    iconClassName: "text-text-secondary",
    itemClassName: "text-text-secondary",
  },
};

/** TodoWrite 工具卡片的增量列表；只展示本次调用相较上一轮变动的待办。复制自 `packages/agent-runtime/web/components/chat/TodoChanges.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。 */
export function TodoChanges({ changes }: TodoChangesProps) {
  if (changes.length === 0) return null;

  return (
    <div className="mx-3 mb-2.5 mt-1 max-h-64 overflow-y-auto overscroll-contain pt-1.5">
      {changes.map((change) => {
        const { Icon, iconClassName, itemClassName } = CHANGE_STYLES[change.kind];
        const text =
          change.kind === "in_progress" ? (change.todo.activeForm ?? change.todo.content) : change.todo.content;
        return (
          <div key={change.id} className="flex items-start gap-2 py-1">
            <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", iconClassName)} />
            <span className={cn("min-w-0 flex-1 text-[11px] leading-relaxed", itemClassName)}>{text}</span>
          </div>
        );
      })}
    </div>
  );
}
