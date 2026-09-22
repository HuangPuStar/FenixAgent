// 复制自 packages/agent-runtime/web/components/chat/chat-status-panel.tsx。
// 纯化改动：
//   - PeriTaskViewProjection / ChangedFile / TodoItem 改从包内 ../types 导入；
//   - cn 改为包内 ../../lib/cn；i18n 由宿主 ns=components 收敛到 UI_COMPONENTS_NS 的
//     chat.components.* key；
//   - 变更文件点击由源实现的 `window.dispatchEvent(new CustomEvent("artifacts:preview-file"))`
//     改为 `onPreviewFile` 回调注入（包内不得触碰宿主事件总线与路由）；
//   - 保留 `.chat-status-list [data-status="..."]` 的 data-* 契约，CSS 消费方无需改动。

import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock3,
  FileDiff,
  ListTodo,
  Network,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import type { ChangedFile, PeriTaskViewProjection, TodoItem } from "../types";

type StatusTab = "todo" | "tasks" | "changes";

/**
 * 从路径中提取文件名（兼容 Windows 反斜杠与结尾斜杠）。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/chat-status-panel.tsx`；纯化改动：无。
 */
export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

/**
 * 行首状态图标配色（源 `.chat-status-list [data-status="…"] svg`）。
 *
 * 未列出的状态（含 `pending` / `cancelled`）沿用默认灰 `#8c9bb0`；尺寸与配色一起给出，
 * 因为原规则同时作用于 `.chat-status-list svg`（15px）与状态色。
 */
function statusIconClass(status: string): string {
  if (status === "completed") return "h-[15px] w-[15px] text-[#25a47a]";
  if (status === "in_progress" || status === "running") return "h-[15px] w-[15px] text-[#d28a27]";
  if (status === "failed") return "h-[15px] w-[15px] text-[#db5d56]";
  return "h-[15px] w-[15px] text-[#8c9bb0]";
}

/** 状态列表容器（三支共用）：源 `.chat-status-list` 的 grid/内边距 + 组件原有的滚动约束。 */
const STATUS_LIST_CLASS =
  "grid max-h-[min(16rem,35vh)] overflow-y-auto overscroll-contain px-3 pt-0.5 pb-2.5 [scrollbar-gutter:stable]";

/** 列表行（todos 的 div / tasks 与 changes 的 button）：源 `.chat-status-list > div, > button`。 */
const STATUS_ROW_CLASS =
  "grid min-h-[29px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 text-left text-[#526178]";

interface ChatStatusPanelProps {
  todos: TodoItem[];
  tasks: readonly PeriTaskViewProjection[];
  tasksLoaded: boolean;
  reconnecting?: boolean;
  changedFiles: ChangedFile[];
  onOpenTask?: (task: PeriTaskViewProjection) => void;
  /** 点击变更文件条目时回调（源实现通过 window 的 artifacts:preview-file 事件广播路径） */
  onPreviewFile?: (path: string) => void;
}

/**
 * 输入框上方唯一的非阻塞状态面板，只消费当前 Y.Doc 投影与消息派生数据。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/chat-status-panel.tsx`。
 * 纯化改动：类型、cn 与 i18n 改为包内导入；文件预览由 `onPreviewFile` 回调注入替代窗口事件；
 * props 全量注入，组件不读取任何传输层状态；无可用 tab 时返回 null。
 */
export function ChatStatusPanel({
  todos,
  tasks,
  tasksLoaded,
  reconnecting = false,
  changedFiles,
  onOpenTask,
  onPreviewFile,
}: ChatStatusPanelProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const availableTabs = useMemo<StatusTab[]>(() => {
    const result: StatusTab[] = [];
    if (todos.length > 0) result.push("todo");
    if (tasks.length > 0) result.push("tasks");
    if (changedFiles.length > 0) result.push("changes");
    return result;
  }, [todos.length, tasks.length, changedFiles.length]);
  const [activeTab, setActiveTab] = useState<StatusTab>(() => availableTabs[0] ?? "todo");
  const [collapsed, setCollapsed] = useState(() => availableTabs[0] === "changes");
  const todoSnapshotRef = useRef<string | null>(null);
  const taskSnapshotRef = useRef<string | null>(null);
  const todoSnapshot = useMemo(
    () => JSON.stringify(todos.map(({ content, status, activeForm }) => [content, status, activeForm ?? null])),
    [todos],
  );
  const taskSnapshot = useMemo(
    () => JSON.stringify(tasks.map(({ taskId, title, status }) => [taskId, title, status])),
    [tasks],
  );

  useEffect(() => {
    if (todoSnapshotRef.current === null) {
      todoSnapshotRef.current = todoSnapshot;
      return;
    }
    if (todoSnapshotRef.current === todoSnapshot) return;

    todoSnapshotRef.current = todoSnapshot;
    if (todos.length > 0) {
      setActiveTab("todo");
      setCollapsed(false);
    }
  }, [todoSnapshot, todos.length]);

  useEffect(() => {
    if (taskSnapshotRef.current === null) {
      taskSnapshotRef.current = taskSnapshot;
      return;
    }
    if (taskSnapshotRef.current === taskSnapshot) return;

    taskSnapshotRef.current = taskSnapshot;
    if (tasks.length > 0) {
      setActiveTab("tasks");
      setCollapsed(false);
    }
  }, [taskSnapshot, tasks.length]);

  useEffect(() => {
    if (availableTabs.includes(activeTab) || !availableTabs[0]) return;
    const nextTab = availableTabs[0];
    setActiveTab(nextTab);
    if (nextTab === "changes") setCollapsed(true);
  }, [activeTab, availableTabs]);

  if (availableTabs.length === 0) return null;

  const completedTodos = todos.filter((todo) => todo.status === "completed").length;

  return (
    <section
      // 源 `.chat-interaction-stack/​.chat-status-panel`（宽度台阶）与 `.chat-status-panel`（半圆卡）两段。
      className="mx-auto w-[min(756px,calc(100%-64px))] [@media(max-width:720px)]:w-[calc(100%-52px)] overflow-hidden rounded-t-[14px] border-x border-t border-b-0 border-[#dde4ee] bg-white shadow-[0_12px_34px_rgb(30_64_120_/_8%)]"
      data-slot="chat-status-panel"
      aria-label={t("chat.components.chatStatus.title")}
    >
      <header className="flex min-h-[40px] w-full items-center gap-[9px] px-[9px] py-1 text-[#33445d]">
        <div
          className="flex min-w-0 items-center gap-0.5"
          role="tablist"
          aria-label={t("chat.components.chatStatus.title")}
        >
          {todos.length > 0 && (
            <StatusTabButton
              active={activeTab === "todo"}
              icon={ListTodo}
              label={t("chat.components.chatStatus.todo")}
              count={`${completedTodos}/${todos.length}`}
              onClick={() => setActiveTab("todo")}
            />
          )}
          {tasks.length > 0 && (
            <StatusTabButton
              active={activeTab === "tasks"}
              icon={Network}
              label={t("chat.components.chatStatus.subtasks")}
              count={String(tasks.length)}
              onClick={() => setActiveTab("tasks")}
            />
          )}
          {changedFiles.length > 0 && (
            <StatusTabButton
              active={activeTab === "changes"}
              icon={FileDiff}
              label={t("chat.components.chatStatus.changes")}
              count={String(changedFiles.length)}
              onClick={() => setActiveTab("changes")}
            />
          )}
        </div>
        <button
          type="button"
          className="ml-auto grid h-7 w-7 place-items-center text-[#8290a5] [&>svg]:w-[15px]"
          aria-label={t("chat.components.chatStatus.toggle")}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </button>
      </header>

      {!collapsed && activeTab === "todo" && <TodoRows todos={todos} />}
      {!collapsed && activeTab === "tasks" && (
        <TaskRows tasks={tasks} loaded={tasksLoaded} reconnecting={reconnecting} onOpenTask={onOpenTask} />
      )}
      {!collapsed && activeTab === "changes" && <ChangeRows files={changedFiles} onPreviewFile={onPreviewFile} />}
    </section>
  );
}

function StatusTabButton({
  active,
  icon: Icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: typeof ListTodo;
  label: string;
  count: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      // 源 `.chat-status-tabs button` 与 `.is-active` 两态（互斥，不靠生成顺序）；窄屏隐藏页签文字。
      className={cn(
        "flex min-h-[30px] items-center gap-1.5 rounded-[7px] px-2 py-1 text-[12px]",
        active ? "bg-[#f1f5fc] text-[#285eb8]" : "text-[#748197]",
      )}
      onClick={onClick}
    >
      <Icon className="h-[15px] w-[15px]" />
      <span className="[@media(max-width:720px)]:hidden">{label}</span>
      <small className="text-[10px] text-[#8a96a8]">{count}</small>
    </button>
  );
}

function TodoRows({ todos }: { todos: TodoItem[] }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  return (
    <div className={STATUS_LIST_CLASS} data-slot="chat-status-list" role="tabpanel">
      {todos.map((todo) => {
        const Icon = todo.status === "completed" ? CheckCircle2 : todo.status === "in_progress" ? Clock3 : Circle;
        return (
          <div key={todo.content} className={STATUS_ROW_CLASS} data-status={todo.status}>
            <Icon className={statusIconClass(todo.status)} />
            <span className="overflow-hidden text-[11.5px] text-ellipsis whitespace-nowrap">
              {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
            </span>
            <small className="text-[10px] text-[#8a96a8]">
              {t(`chat.components.chatStatus.todoStatus.${todo.status}`)}
            </small>
          </div>
        );
      })}
    </div>
  );
}

function TaskRows({
  tasks,
  loaded,
  reconnecting,
  onOpenTask,
}: {
  tasks: readonly PeriTaskViewProjection[];
  loaded: boolean;
  reconnecting: boolean;
  onOpenTask?: (task: PeriTaskViewProjection) => void;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  if (!loaded)
    return <p className="px-3 pt-1.5 pb-2.5 text-[11px] text-[#7f8ca0]">{t("chat.components.periTask.loading")}</p>;
  return (
    <div className={STATUS_LIST_CLASS} data-slot="chat-status-list" role="tabpanel">
      {reconnecting && (
        <p className="px-3 pt-1.5 pb-2.5 text-[11px] text-[#7f8ca0]">{t("chat.components.periTask.reconnecting")}</p>
      )}
      {tasks.map((task) => {
        const Icon =
          task.status === "completed"
            ? CheckCircle2
            : task.status === "failed"
              ? XCircle
              : task.status === "cancelled"
                ? Ban
                : Clock3;
        const canOpen = task.detailAvailability !== "unavailable" && onOpenTask;
        return (
          <button
            key={task.taskId}
            type="button"
            className={STATUS_ROW_CLASS}
            data-status={task.status}
            disabled={!canOpen}
            onClick={() => canOpen && onOpenTask(task)}
          >
            <Icon className={statusIconClass(task.status)} />
            <span className="overflow-hidden text-[11.5px] text-ellipsis whitespace-nowrap">
              {task.title || t("chat.components.periTask.unknownTitle")}
            </span>
            <small className="text-[10px] text-[#8a96a8]">{t(`chat.components.periTask.status.${task.status}`)}</small>
          </button>
        );
      })}
    </div>
  );
}

function ChangeRows({ files, onPreviewFile }: { files: ChangedFile[]; onPreviewFile?: (path: string) => void }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  return (
    <div className={STATUS_LIST_CLASS} data-slot="chat-status-list" role="tabpanel">
      {files.map((file) => (
        <button key={file.path} type="button" className={STATUS_ROW_CLASS} onClick={() => onPreviewFile?.(file.path)}>
          <FileDiff className="h-[15px] w-[15px] text-[#8c9bb0]" />
          <span className="overflow-hidden text-[11.5px] text-ellipsis whitespace-nowrap" title={file.path}>
            {fileNameFromPath(file.path)}
          </span>
          {/* 源 `.chat-status-list small.is-added`：写操作标绿，其余沿用默认灰（互斥两态）。 */}
          <small className={file.type === "write" ? "text-[10px] text-[#259a70]" : "text-[10px] text-[#8a96a8]"}>
            {t(file.type === "write" ? "chat.components.chatStatus.added" : "chat.components.chatStatus.modified")}
          </small>
        </button>
      ))}
    </div>
  );
}
