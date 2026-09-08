import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  Clock3,
  FileDiff,
  ListTodo,
  Network,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { DemoScenarioId } from "./demo-model";
import { useDemoTranslation } from "./use-demo-copy";

const SCENARIO_TODOS: Partial<Record<DemoScenarioId, readonly string[]>> = {
  longConversation: ["todo.long1", "todo.long2", "todo.long3"],
  tools: ["todo.tool1", "todo.tool2", "todo.tool3"],
  permission: ["todo.permission1", "todo.permission2", "todo.permission3"],
  subtask: ["todo.subtask1", "todo.subtask2", "todo.subtask3"],
};

type StatusTab = "todo" | "subtasks" | "changes";

const CHANGED_FILES = [
  { path: "chat-demo/demo-status-panel.tsx", state: "M", label: "已修改" },
  { path: "chat-demo/chat-demo-overlays.css", state: "M", label: "已修改" },
  { path: "chat-demo/composer-context-meter.tsx", state: "A", label: "新增" },
  { path: "chat-demo/chat-canvas.tsx", state: "M", label: "已修改" },
] as const;

/** Combines TodoWrite and session subtask projections in one input-adjacent status surface. */
export function DemoStatusPanel({ scenarioId }: { scenarioId: DemoScenarioId }) {
  const { t } = useDemoTranslation();
  const [activeTab, setActiveTab] = useState<StatusTab>(scenarioId === "subtask" ? "subtasks" : "todo");
  const [collapsed, setCollapsed] = useState(false);
  const todoKeys = SCENARIO_TODOS[scenarioId] ?? ["todo.default1", "todo.default2", "todo.default3"];

  if (scenarioId === "empty" || scenarioId === "assets") return null;

  return (
    <section className="chat-demo__status-panel" aria-label={t("statusPanel.title")}>
      <header className="chat-demo__status-header">
        <div className="chat-demo__status-tabs">
          <button
            type="button"
            className={activeTab === "todo" ? "is-active" : undefined}
            onClick={() => {
              setActiveTab("todo");
              setCollapsed(false);
            }}
          >
            <ListTodo />
            {t("todo.title")}
            <span>1/3</span>
          </button>
          <button
            type="button"
            className={activeTab === "subtasks" ? "is-active" : undefined}
            onClick={() => {
              setActiveTab("subtasks");
              setCollapsed(false);
            }}
          >
            <Network />
            {t("statusPanel.subtasks")}
            <span>3</span>
          </button>
          <button
            type="button"
            className={activeTab === "changes" ? "is-active" : undefined}
            onClick={() => {
              setActiveTab("changes");
              setCollapsed(false);
            }}
          >
            <FileDiff />
            Changes
            <span>{CHANGED_FILES.length}</span>
          </button>
        </div>
        <button
          type="button"
          className="chat-demo__status-collapse"
          aria-label={t("statusPanel.toggle")}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </button>
      </header>
      {!collapsed && activeTab === "todo" && (
        <div className="chat-demo__todo-list">
          {todoKeys.map((key, index) => (
            <div key={key} data-status={index === 0 ? "complete" : index === 1 ? "running" : "pending"}>
              {index === 0 ? <CircleCheck /> : index === 1 ? <Clock3 /> : <Circle />}
              <span>{t(key)}</span>
              <small>{t(index === 0 ? "status.complete" : index === 1 ? "status.running" : "status.queued")}</small>
            </div>
          ))}
        </div>
      )}
      {!collapsed && activeTab === "subtasks" && <SubtaskStatusList />}
      {!collapsed && activeTab === "changes" && <ChangesList />}
    </section>
  );
}

function ChangesList() {
  return (
    <div className="chat-demo__changes">
      <div className="chat-demo__changes-copy">
        <strong>文件更改</strong>
        <span>当前会话修改了 {CHANGED_FILES.length} 个文件</span>
      </div>
      <div className="chat-demo__changes-list">
        {CHANGED_FILES.map((file) => (
          <div key={file.path}>
            <FileDiff />
            <span title={file.path}>{file.path}</span>
            <small data-state={file.state}>{file.label}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function SubtaskStatusList() {
  const { t } = useDemoTranslation();
  const tasks = [
    ["apiTitle", "complete"],
    ["securityTitle", "failed"],
    ["testTitle", "running"],
  ] as const;
  return (
    <div className="chat-demo__status-subtasks">
      {tasks.map(([title, status]) => (
        <div key={title} data-status={status}>
          {status === "complete" ? <CircleCheck /> : status === "failed" ? <XCircle /> : <Clock3 />}
          <span>{t(`subtask.${title}`)}</span>
          <small>{t(`status.${status}`)}</small>
        </div>
      ))}
    </div>
  );
}
