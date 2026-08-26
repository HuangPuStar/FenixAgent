import type { PeriTaskViewProjection } from "@fenix/chat-channel";
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
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChangedFile } from "../../src/lib/extract-changed-files";
import type { TodoItem } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";

type StatusTab = "todo" | "tasks" | "changes";

interface ChatStatusPanelProps {
  todos: TodoItem[];
  tasks: readonly PeriTaskViewProjection[];
  tasksLoaded: boolean;
  reconnecting?: boolean;
  changedFiles: ChangedFile[];
  onOpenTask?: (task: PeriTaskViewProjection) => void;
}

/** 输入框上方唯一的非阻塞状态面板，只消费当前 Y.Doc 投影与消息派生数据。 */
export function ChatStatusPanel({
  todos,
  tasks,
  tasksLoaded,
  reconnecting = false,
  changedFiles,
  onOpenTask,
}: ChatStatusPanelProps) {
  const { t } = useTranslation("components");
  const availableTabs = useMemo<StatusTab[]>(() => {
    const result: StatusTab[] = [];
    if (todos.length > 0) result.push("todo");
    if (tasks.length > 0) result.push("tasks");
    if (changedFiles.length > 0) result.push("changes");
    return result;
  }, [todos.length, tasks.length, changedFiles.length]);
  const [activeTab, setActiveTab] = useState<StatusTab>("todo");
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!availableTabs.includes(activeTab) && availableTabs[0]) setActiveTab(availableTabs[0]);
  }, [activeTab, availableTabs]);

  if (availableTabs.length === 0) return null;

  const completedTodos = todos.filter((todo) => todo.status === "completed").length;

  return (
    <section className="chat-status-panel" aria-label={t("chatStatus.title")}>
      <header className="chat-status-header">
        <div className="chat-status-tabs" role="tablist" aria-label={t("chatStatus.title")}>
          {todos.length > 0 && (
            <StatusTabButton
              active={activeTab === "todo"}
              icon={ListTodo}
              label={t("chatStatus.todo")}
              count={`${completedTodos}/${todos.length}`}
              onClick={() => setActiveTab("todo")}
            />
          )}
          {tasks.length > 0 && (
            <StatusTabButton
              active={activeTab === "tasks"}
              icon={Network}
              label={t("chatStatus.subtasks")}
              count={String(tasks.length)}
              onClick={() => setActiveTab("tasks")}
            />
          )}
          {changedFiles.length > 0 && (
            <StatusTabButton
              active={activeTab === "changes"}
              icon={FileDiff}
              label={t("chatStatus.changes")}
              count={String(changedFiles.length)}
              onClick={() => setActiveTab("changes")}
            />
          )}
        </div>
        <button
          type="button"
          className="chat-status-collapse"
          aria-label={t("chatStatus.toggle")}
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
      {!collapsed && activeTab === "changes" && <ChangeRows files={changedFiles} />}
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
  const { t } = useTranslation("components");
  return (
    <div className="chat-status-list" role="tabpanel">
      {todos.map((todo) => {
        const Icon = todo.status === "completed" ? CheckCircle2 : todo.status === "in_progress" ? Clock3 : Circle;
        return (
          <div key={todo.content} data-status={todo.status}>
            <Icon />
            <span>{todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}</span>
            <small>{t(`chatStatus.todoStatus.${todo.status}`)}</small>
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
  const { t } = useTranslation("components");
  if (!loaded) return <p className="chat-status-note">{t("periTask.loading")}</p>;
  return (
    <div className="chat-status-list" role="tabpanel">
      {reconnecting && <p className="chat-status-note">{t("periTask.reconnecting")}</p>}
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
            <span>{task.title || t("periTask.unknownTitle")}</span>
            <small>{t(`periTask.status.${task.status}`)}</small>
          </button>
        );
      })}
    </div>
  );
}

function ChangeRows({ files }: { files: ChangedFile[] }) {
  const { t } = useTranslation("components");
  return (
    <div className="chat-status-list" role="tabpanel">
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("artifacts:preview-file", { detail: { path: file.path } }))
          }
        >
          <FileDiff />
          <span title={file.path}>{file.path}</span>
          <small className={cn(file.type === "write" && "is-added")}>
            {t(file.type === "write" ? "chatStatus.added" : "chatStatus.modified")}
          </small>
        </button>
      ))}
    </div>
  );
}
