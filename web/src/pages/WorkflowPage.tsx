import { useCallback, useEffect, useState } from "react";
import { WorkflowList } from "./workflow/WorkflowList";
import { WorkflowEditor } from "./workflow/WorkflowEditor";
import { WorkflowVersions } from "./workflow/WorkflowVersions";
import { WorkflowRuns } from "./workflow/WorkflowRuns";
import { Pencil, History, ArrowLeft } from "lucide-react";

type WfView = "list" | "edit" | "versions" | "runs";

interface WfRoute {
  view: WfView;
  workflowId?: string;
  runId?: string;
}

function parseWfPath(): WfRoute {
  const path = window.location.pathname.replace(/^\/ctrl\/?/, "");
  const parts = path.split("/");
  const params = new URLSearchParams(window.location.search);
  const runId = params.get("runId") ?? undefined;

  if (parts[0] !== "workflow") return { view: "list" };

  // /ctrl/workflow/runs
  if (parts[1] === "runs") {
    return { view: "runs" };
  }
  // /ctrl/workflow/:workflowId/versions
  if (parts[1] && parts[2] === "versions") {
    return { view: "versions", workflowId: parts[1] };
  }
  // /ctrl/workflow/:workflowId/edit
  if (parts[1] && parts[2] === "edit") {
    return { view: "edit", workflowId: parts[1], runId };
  }
  // /ctrl/workflow（默认列表页）
  return { view: "list" };
}

const TAB_ITEMS = [
  { id: "list" as const, label: "工作流", icon: Pencil },
  { id: "runs" as const, label: "运行记录", icon: History },
];

export function WorkflowPage() {
  const [route, setRoute] = useState(parseWfPath);

  useEffect(() => {
    const sync = () => setRoute(parseWfPath());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const navigateTo = useCallback((view: WfView, workflowId?: string, runId?: string) => {
    let path = "/ctrl/workflow";
    if (view === "runs") path = "/ctrl/workflow/runs";
    if (view === "edit" && workflowId) path = `/ctrl/workflow/${workflowId}/edit`;
    if (view === "versions" && workflowId) path = `/ctrl/workflow/${workflowId}/versions`;
    if (runId) path += `?runId=${runId}`;
    window.history.pushState(null, "", path);
    setRoute({ view, workflowId, runId });
  }, []);

  // 全屏独立视图：编辑器
  if (route.view === "edit" && route.workflowId) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 16px",
            borderBottom: "1px solid #e5e7eb",
            background: "#fff",
            minHeight: 40,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={() => navigateTo("list")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 8px",
              border: "none",
              background: "none",
              fontSize: 12,
              color: "#6b7280",
              cursor: "pointer",
            }}
          >
            <ArrowLeft size={14} /> 返回列表
          </button>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <WorkflowEditor workflowId={route.workflowId} runId={route.runId} />
        </div>
      </div>
    );
  }

  // 全屏独立视图：版本历史
  if (route.view === "versions" && route.workflowId) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 16px",
            borderBottom: "1px solid #e5e7eb",
            background: "#fff",
            minHeight: 40,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={() => navigateTo("list")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 8px",
              border: "none",
              background: "none",
              fontSize: 12,
              color: "#6b7280",
              cursor: "pointer",
            }}
          >
            <ArrowLeft size={14} /> 返回列表
          </button>
          <button
            type="button"
            onClick={() => navigateTo("edit", route.workflowId)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 8px",
              border: "none",
              background: "none",
              fontSize: 12,
              color: "#6b7280",
              cursor: "pointer",
            }}
          >
            <Pencil size={14} /> 编辑器
          </button>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <WorkflowVersions workflowId={route.workflowId} onEditWorkflow={(id) => navigateTo("edit", id)} />
        </div>
      </div>
    );
  }

  // Tab 框架：工作流列表 / 运行记录
  const activeTab = route.view === "list" ? "list" : "runs";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          padding: "0 20px",
          borderBottom: "1px solid #e5e7eb",
          background: "#fff",
          minHeight: 40,
          flexShrink: 0,
        }}
      >
        {TAB_ITEMS.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => navigateTo(tab.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "8px 14px",
                border: "none",
                background: "none",
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "#111827" : "#6b7280",
                borderBottom: isActive ? "2px solid #3b82f6" : "2px solid transparent",
                cursor: "pointer",
                transition: "color 0.15s, border-color 0.15s",
              }}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeTab === "list" ? (
          <WorkflowList
            onEditWorkflow={(id) => navigateTo("edit", id)}
            onViewVersions={(id) => navigateTo("versions", id)}
          />
        ) : (
          <WorkflowRuns
            onSelectRun={(runId, workflowId) => {
              if (workflowId) navigateTo("edit", workflowId, runId);
            }}
          />
        )}
      </div>
    </div>
  );
}
