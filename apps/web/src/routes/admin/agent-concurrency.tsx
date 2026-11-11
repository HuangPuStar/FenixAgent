import { AGENT_CONCURRENCY_NS } from "@fenix/agent-runtime/web/i18n";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AgentConcurrencyPage = lazy(() =>
  import("@fenix/agent-runtime/web/pages/admin/AgentConcurrencyPage").then((module) => ({
    default: module.AgentConcurrencyPage,
  })),
);
export const Route = createFileRoute("/admin/agent-concurrency")({ component: ConcurrencyRoute });
function ConcurrencyRoute() {
  const { t } = useTranslation(AGENT_CONCURRENCY_NS);
  return (
    <Suspense fallback={<Spinner variant="screen" label={t("loading")} />}>
      <AgentConcurrencyPage />
    </Suspense>
  );
}
