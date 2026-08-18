// web/components/chat/PeriTaskList.tsx
// Peri Task 会话活动面板（切片 2）：从 Session Doc 的 tasks/taskOrder 投影派生，
// 接入 ChatInterface 聊天区域顶部（ChatView 上方）。
//
// 状态覆盖：
// - loading：Session Doc 快照未同步（tasks/taskOrder 子树缺失）→ 紧凑加载行；
// - empty：已同步但无任务 → "暂无任务"占位行；
// - reconnecting：WS 重连中任务列表可能暂时不完整 → 面板内提示行（主界面仅在
//   connected 时渲染 ChatInterface，此为防御性展示）；
// - 全部任务进入终态 → 自动折叠为标题行（保留活跃计数提示，参考 TodoPanel 的
//   allCompleted 自动折叠模式）；出现新的 running 任务时自动展开。
//
// 不创建任何第三方请求：preview 的 summary 已随投影同步到 Doc，本组件只读展示。
// React.memo + 调用方 selector 的稳定引用保证：任务内容未变时列表不重渲染。

import type { PeriTaskViewProjection } from "@fenix/chat-channel";
import { Loader2 } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PeriTaskViewCard } from "./PeriTaskViewCard";

interface PeriTaskListProps {
  tasks: readonly PeriTaskViewProjection[];
  onOpenDetail?: (task: PeriTaskViewProjection) => void;
  /** Session Doc 的 tasks/taskOrder 子树是否已同步（未同步显示加载态） */
  loaded: boolean;
  /** WS 重连中：任务列表可能暂时不完整（防御性提示，主界面仅在 connected 时渲染） */
  reconnecting?: boolean;
}

/** 面板 body 的稳定 id：供折叠按钮 aria-controls 引用 */
const BODY_ID = "peri-task-list-body";

export const PeriTaskList = memo(function PeriTaskList({
  tasks,
  loaded,
  reconnecting = false,
  onOpenDetail,
}: PeriTaskListProps) {
  const { t } = useTranslation("components");
  const [collapsed, setCollapsed] = useState(false);

  // 活跃（非终态）任务数：驱动头部计数与自动折叠判断；依赖收窄到 tasks 引用
  const activeCount = useMemo(() => tasks.filter((task) => task.status === "running").length, [tasks]);

  // 全部终态 → 自动折叠（header 仍显示计数）；出现活跃任务时自动展开，
  // 保证运行中的任务第一时间可见（与 TodoPanel 的 allCompleted 折叠语义一致）
  const allTerminal = tasks.length > 0 && activeCount === 0;
  useEffect(() => {
    if (allTerminal) setCollapsed(true);
    else if (activeCount > 0) setCollapsed(false);
  }, [allTerminal, activeCount]);

  return (
    <div className="mx-auto max-w-3xl w-full px-4 sm:px-8 pt-1">
      <div className="rounded-lg border border-border bg-surface-2/50 overflow-hidden">
        {/* 头部：标题 + 活跃计数/同步中指示 + 折叠按钮（aria-expanded 标注展开态） */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-controls={BODY_ID}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-1/70 transition-colors"
        >
          <span className="font-display font-medium text-text-secondary">{t("periTask.title")}</span>
          {!loaded ? (
            <span className="flex items-center gap-1 text-text-muted" role="status">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("periTask.syncing")}
            </span>
          ) : activeCount > 0 ? (
            <span className="flex items-center gap-1 text-status-running">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("periTask.activeCount", { count: activeCount })}
            </span>
          ) : null}
          <span className="ml-auto text-text-dim" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>
        </button>

        {/* 重连中提示（防御性：主界面仅在 connected 时渲染本组件） */}
        {reconnecting && (
          <div className="px-3 py-1 text-[10px] bg-warning-bg/60 text-warning-text" role="status">
            {t("periTask.reconnecting")}
          </div>
        )}

        {!collapsed && (
          <div id={BODY_ID} className="max-h-64 overflow-y-auto border-t border-border/50">
            {!loaded ? (
              // 加载态：Session Doc 快照尚未同步，任务列表不可用
              <div className="px-3 py-2 text-[11px] text-text-muted" role="status">
                {t("periTask.loading")}
              </div>
            ) : tasks.length === 0 ? (
              // 空态：已同步但当前会话暂无 Task 活动
              <div className="px-3 py-2 text-[11px] text-text-muted">{t("periTask.empty")}</div>
            ) : (
              <ul className="px-3 py-1 divide-y divide-border/30">
                {tasks.map((task) => (
                  <PeriTaskViewCard key={task.taskId} task={task} onOpenDetail={onOpenDetail} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
