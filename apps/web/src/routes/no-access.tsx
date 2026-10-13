import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ErrorPage } from "@/src/components/error-page";
import { NS } from "@/src/i18n";

export const Route = createFileRoute("/no-access")({
  component: NoAccessPage,
});

function NoAccessPage() {
  const { t } = useTranslation(NS.COMMON);

  return <ErrorPage code="403" message={t("no_access")} backLabel={t("back_home")} />;
}
