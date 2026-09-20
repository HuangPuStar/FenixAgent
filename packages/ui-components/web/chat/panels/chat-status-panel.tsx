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

import { cn } from "../../lib/cn";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
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
    <section className="chat-status-panel" aria-label={t("chat.components.chatStatus.title")}>
      <header className="chat-status-header">
        <div className="chat-status-tabs" role="tablist" aria-label={t("chat.components.chatStatus.title")}>
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
          className="chat-status-collapse"
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
      className={active ? "is-active" : undefined}
      onClick={onClick}
    >
      <Icon />
      <span>{label}</span>
      <small>{count}</small>
    </button>
  );
}

function TodoRows({ todos }: { todos: TodoItem[] }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  return (
    <div
      className="chat-status-list max-h-[min(16rem,35vh)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      role="tabpanel"
    >
      {todos.map((todo) => {
        const Icon = todo.status === "completed" ? CheckCircle2 : todo.status === "in_progress" ? Clock3 : Circle;
        return (
          <div key={todo.content} data-status={todo.status}>
            <Icon />
            <span>{todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}</span>
            <small>{t(`chat.components.chatStatus.todoStatus.${todo.status}`)}</small>
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
  if (!loaded) return <p className="chat-status-note">{t("chat.components.periTask.loading")}</p>;
  return (
    <div
      className="chat-status-list max-h-[min(16rem,35vh)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      role="tabpanel"
    >
      {reconnecting && <p className="chat-status-note">{t("chat.components.periTask.reconnecting")}</p>}
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
            data-status={task.status}
            disabled={!canOpen}
            onClick={() => canOpen && onOpenTask(task)}
          >
            <Icon />
            <span>{task.title || t("chat.components.periTask.unknownTitle")}</span>
            <small>{t(`chat.components.periTask.status.${task.status}`)}</small>
          </button>
        );
      })}
    </div>
  );
}

function ChangeRows({ files, onPreviewFile }: { files: ChangedFile[]; onPreviewFile?: (path: string) => void }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  return (
    <div
      className="chat-status-list max-h-[min(16rem,35vh)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      role="tabpanel"
    >
      {files.map((file) => (
        <button key={file.path} type="button" onClick={() => onPreviewFile?.(file.path)}>
          <FileDiff />
          <span title={file.path}>{fileNameFromPath(file.path)}</span>
          <small className={cn(file.type === "write" && "is-added")}>
            {t(file.type === "write" ? "chat.components.chatStatus.added" : "chat.components.chatStatus.modified")}
          </small>
        </button>
      ))}
    </div>
  );
}
