import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { useTranslation } from "react-i18next";

export function AgentDashboardPage() {
  const { t } = useTranslation("dashboard");

  return (
    <AppPage>
      <AppHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="flex flex-col items-center justify-center py-16 text-text-muted">
        <p className="text-sm">{t("welcome")}</p>
      </div>
    </AppPage>
  );
}
