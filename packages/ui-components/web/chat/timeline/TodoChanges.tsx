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
    // `overscroll-contain` 已移除（2026-09-23）：本块是**消息流内**的滚动容器，而列表通常只有几条、
    // 根本没有可滚动溢出；带 contain 时浏览器会把指针落在它上面的滚轮判定为「本容器消费」，既不滚动
    // 本块、也不再链式传给消息时间线 —— 形成一块随卡片位置移动的滚轮死区（实测：消息区
    // clientHeight 545 / scrollHeight 1272 / scrollTop 364 时，指针在本块上滚轮 ±400 均零位移；
    // 同为 364 的指针只要移到块外正文上即可滚到 0；仅摘掉本类后同一落点也恢复可滚）。
    // 限高与内部滚动（`max-h-64 overflow-y-auto`）不受影响：块内滚到底后由浏览器按默认行为续滚会话区。
    <div className="mx-3 mb-2.5 mt-1 max-h-64 overflow-y-auto pt-1.5">
      {changes.map((change) => {
        const { Icon, iconClassName, itemClassName } = CHANGE_STYLES[change.kind];
        const text =
          change.kind === "in_progress" ? (change.todo.activeForm ?? change.todo.content) : change.todo.content;
        return (
          <div key={change.id} className="flex items-start gap-2 py-1">
            <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", iconClassName)} />
            <span className={cn("min-w-0 flex-1 text-3xs leading-relaxed", itemClassName)}>{text}</span>
          </div>
        );
      })}
    </div>
  );
}
