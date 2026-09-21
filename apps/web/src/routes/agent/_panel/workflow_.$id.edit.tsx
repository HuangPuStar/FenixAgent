import { createFileRoute, useSearch } from "@tanstack/react-router";
import { Loader } from "lucide-react";
import { lazy, Suspense } from "react";
import { WorkflowBreadcrumb } from "@/src/pages/workflow/WorkflowBreadcrumb";

const WorkflowEditor = lazy(() =>
  import("@/src/pages/workflow/WorkflowEditor").then((m) => ({ default: m.WorkflowEditor })),
);

// Meta Agent 聊天面板由宿主注入：workflow 包不得依赖 apps（`web-package-not-to-app`），
// 而 ChatPanel 是宿主接线层（宿主 i18n + identity 的 web 会话）。同型先例见
// `apps/web/src/routes/view/$prodViewId.tsx` 注入的 `ChatArea`。
const ChatPanel = lazy(() => import("@/src/pages/agent-panel/ChatPanel").then((m) => ({ default: m.ChatPanel })));

function WorkflowEditPage() {
  const { id } = Route.useParams();
  const search = useSearch({ strict: false }) as { runId?: string };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <WorkflowBreadcrumb workflowId={id} />
      <div className="flex-1 min-h-0 overflow-hidden">
        <WorkflowEditor workflowId={id} runId={search.runId} chatPanel={ChatPanel} />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow_/$id/edit")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <Loader className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <WorkflowEditPage />
    </Suspense>
  ),
});
