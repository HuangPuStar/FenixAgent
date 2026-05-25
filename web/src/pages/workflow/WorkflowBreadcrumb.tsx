import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

interface WorkflowBreadcrumbProps {
  workflowId: string;
  workflowName?: string;
  children?: React.ReactNode;
}

export function WorkflowBreadcrumb({ workflowName, children }: WorkflowBreadcrumbProps) {
  const { t } = useTranslation("workflows");

  return (
    <div className="flex items-center gap-2 px-4 h-9 border-b border-border-subtle bg-surface-base flex-shrink-0">
      <Link
        to="/agent/workflow"
        className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        <ArrowLeft size={13} />
        <span>{t("page.breadcrumb_back")}</span>
      </Link>
      {workflowName && (
        <>
          <span className="text-text-dim text-xs">/</span>
          <span className="text-xs font-medium text-text-primary truncate max-w-[200px]">{workflowName}</span>
        </>
      )}
      {children && (
        <>
          <span className="text-text-dim text-xs">/</span>
          <div className="flex items-center gap-1.5">{children}</div>
        </>
      )}
    </div>
  );
}
