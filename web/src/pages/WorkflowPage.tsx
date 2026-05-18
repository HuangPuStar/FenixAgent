import { useCallback, useEffect, useState } from "react";
import { WorkflowEditor } from "./workflow/WorkflowEditor";
import { WorkflowRuns } from "./workflow/WorkflowRuns";
import { WorkflowRunDetail } from "./workflow/WorkflowRunDetail";
import { Pencil, History } from "lucide-react";

type WfView = "editor" | "runs" | "detail";

function parseWfPath(): { view: WfView; runId?: string } {
  const path = window.location.pathname.replace(/^\/ctrl\/?/, "");
  const parts = path.split("/");

  if (parts[0] !== "workflow") return { view: "editor" };

  if (parts[1] === "runs" && parts[2]) {
    return { view: "detail", runId: parts[2] };
  }
  if (parts[1] === "runs") {
    return { view: "runs" };
  }
  return { view: "editor" };
}

const TAB_ITEMS = [
  { id: "editor" as const, label: "编排编辑器", icon: Pencil },
  { id: "runs" as const, label: "运行记录", icon: History },
];

export function WorkflowPage() {
  const [route, setRoute] = useState(parseWfPath);

  useEffect(() => {
    const sync = () => setRoute(parseWfPath());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const navigateTo = useCallback((view: WfView, runId?: string) => {
    let path = "/ctrl/workflow";
    if (view === "runs") path = "/ctrl/workflow/runs";
    if (view === "detail" && runId) path = `/ctrl/workflow/runs/${runId}`;
    window.history.pushState(null, "", path);
    setRoute({ view, runId });
  }, []);

  // 详情页：全屏独立视图，带返回按钮
  if (route.view === "detail" && route.runId) {
    return <WorkflowRunDetail runId={route.runId} onBack={() => navigateTo("runs")} />;
  }

  // 编辑器 / 列表页：共用顶部 Tab 框架
  const activeTab = route.view === "detail" ? "runs" : route.view;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 顶部 Tab 栏 */}
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

      {/* 内容区域 */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeTab === "editor" ? (
          <WorkflowEditor
            onViewRuns={() => navigateTo("runs")}
            onRunStarted={(runId) => navigateTo("detail", runId)}
          />
        ) : (
          <WorkflowRuns onSelectRun={(id) => navigateTo("detail", id)} />
        )}
      </div>
    </div>
  );
}
