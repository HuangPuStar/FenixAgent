import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, History, Pencil } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { WorkflowEditor } from "./workflow/WorkflowEditor";
import { WorkflowList } from "./workflow/WorkflowList";
import { WorkflowRuns } from "./workflow/WorkflowRuns";
import { WorkflowVersions } from "./workflow/WorkflowVersions";
import { parseWorkflowPath, type WfRoute, type WfView, WORKFLOW_LIST_PATH } from "./workflow/workflow-path";

function TabItems(t: (key: string) => string) {
  return [
    { id: "list" as const, label: t("page.tab_workflows"), icon: Pencil },
    { id: "runs" as const, label: t("page.tab_runs"), icon: History },
  ];
}

/**
 * 本页的导航契约（P0 禁令相关，改动前先读这里）。
 *
 * 页面原先自持 `/ctrl/workflow/*` 子路由：`window.history.pushState` 改写地址栏 + 本地 state 跟随
 * popstate。前端规范把 location 写操作列为 P0 禁令（`docs/developer/guide/frontend-development.md`
 * 的导航一节），因此改为「状态从 Router 派生、跳转走 Router」：`useLocation()` 订阅当前地址，
 * `useNavigate()` 按**已注册**的路由 ID 跳转。视图解析（含路径空间为什么是 `/agent/workflow`）
 * 在 `./workflow/workflow-path`，那里是纯函数、有独立用例。
 */
export function WorkflowPage() {
  const { t } = useTranslation("workflows");
  const navigate = useNavigate();
  const location = useLocation();
  // `strict: false`：本页不拥有路由定义，只能读当前匹配上的全部 search（`runId` 由编辑视图消费）
  const search = useSearch({ strict: false }) as { runId?: string };
  // 视图每轮渲染从 Router 的 pathname 派生，不再维护第二份路由 state：
  // 上一版用 state + popstate 手工跟随地址栏，前进/后退之外的程序化跳转必须自己补一次 setState，
  // 两份状态一旦分叉就会出现「地址栏已变、界面没变」。
  const route: WfRoute = { ...parseWorkflowPath(location.pathname), runId: search.runId };

  const navigateTo = useCallback(
    (view: WfView, workflowId?: string, runId?: string) => {
      if (view === "edit" && workflowId) {
        void navigate({
          to: "/agent/workflow/$id/edit",
          params: { id: workflowId },
          search: runId ? { runId } : {},
        });
        return;
      }
      if (view === "versions" && workflowId) {
        void navigate({ to: "/agent/workflow/$id/versions", params: { id: workflowId } });
        return;
      }
      if (view === "runs") {
        void navigate({ to: WORKFLOW_LIST_PATH, search: { tab: "runs" } });
        return;
      }
      void navigate({ to: WORKFLOW_LIST_PATH });
    },
    [navigate],
  );

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
            <ArrowLeft size={14} /> {t("page.back_to_list")}
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
            <ArrowLeft size={14} /> {t("page.back_to_list")}
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
            <Pencil size={14} /> {t("page.editor")}
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
        {TabItems(t).map((tab) => {
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
