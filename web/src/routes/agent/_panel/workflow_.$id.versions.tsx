import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { WorkflowBreadcrumb } from "../../../pages/workflow/WorkflowBreadcrumb";

const WorkflowVersions = lazy(() =>
  import("../../../pages/workflow/WorkflowVersions").then((m) => ({ default: m.WorkflowVersions })),
);

function WorkflowVersionsPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { t } = useTranslation("workflows");

  const onEditWorkflow = useCallback(
    (workflowId: string) => {
      void navigate({
        to: "/agent/workflow/$id/edit",
        params: { id: workflowId },
      });
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <WorkflowBreadcrumb workflowId={id}>
        <Link
          to="/agent/workflow/$id/edit"
          params={{ id }}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <Pencil size={12} />
          <span>{t("page.breadcrumb_edit")}</span>
        </Link>
      </WorkflowBreadcrumb>
      <div className="flex-1 min-h-0 overflow-hidden">
        <WorkflowVersions workflowId={id} onEditWorkflow={onEditWorkflow} />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow_/$id/versions")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <WorkflowVersionsPage />
    </Suspense>
  ),
});
