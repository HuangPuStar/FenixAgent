import { CheckCircle, Circle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TodoItem } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";

// =============================================================================
// Todo 条目类型
// =============================================================================

interface TodoPanelProps {
  todos: TodoItem[];
}

// =============================================================================
// Todo 面板 — 显示在 ChatInput 上方，紧凑迷你列表
// =============================================================================

export function TodoPanel({ todos }: TodoPanelProps) {
  const { t } = useTranslation("components");
  const [collapsed, setCollapsed] = useState(false);

  // 全部完成时自动折叠
  const allCompleted = todos.length > 0 && todos.every((t) => t.status === "completed");
  useEffect(() => {
    if (allCompleted) setCollapsed(true);
  }, [allCompleted]);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;

  return (
    <div className="mx-auto max-w-3xl w-full px-4 sm:px-8 pb-1">
      <div className="rounded-lg border border-border bg-surface-2/50 overflow-hidden">
        {/* 头部 — 摘要 + 折叠按钮 */}
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-1/70 transition-colors"
          onClick={() => setCollapsed(!collapsed)}
        >
          {/* 进度指示 */}
          <div className="flex gap-0.5">
            {todos.map((todo) => (
              <div
                key={todo.content}
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  todo.status === "completed" && "bg-status-active",
                  todo.status === "in_progress" && "bg-status-running animate-pulse",
                  todo.status === "pending" && "bg-text-muted/40",
                )}
              />
            ))}
          </div>

          <span className="text-text-muted font-mono tabular-nums">
            {completed}/{todos.length} {t("todoPanel.completed")}
          </span>

          {inProgress > 0 && (
            <span className="flex items-center gap-1 text-status-running">
              <Circle className="h-3 w-3 text-status-running" />
              <span>
                {inProgress} {t("todoPanel.inProgress")}
              </span>
            </span>
          )}

          <span className="ml-auto text-text-dim">{collapsed ? "▸" : "▾"}</span>
        </button>

        {/* Todo 列表 */}
        {!collapsed && (
          <div className="border-t border-border/50 px-3 py-1 divide-y divide-border/30">
            {todos.map((todo) => (
              <div key={todo.content} className="flex items-start gap-2 py-1">
                {todo.status === "completed" ? (
                  <CheckCircle className="h-3.5 w-3.5 mt-0.5 text-status-active flex-shrink-0" />
                ) : todo.status === "in_progress" ? (
                  <Circle className="h-3.5 w-3.5 mt-0.5 text-status-running flex-shrink-0" />
                ) : (
                  <Circle className="h-3.5 w-3.5 mt-0.5 text-text-muted/40 flex-shrink-0" />
                )}
                <span
                  className={cn(
                    "text-[11px] leading-relaxed",
                    todo.status === "completed" && "text-text-muted line-through",
                    todo.status === "in_progress" && "text-text-primary font-medium",
                    todo.status === "pending" && "text-text-secondary",
                  )}
                >
                  {todo.activeForm && todo.status === "in_progress" ? todo.activeForm : todo.content}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
