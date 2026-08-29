import { useTranslation } from "react-i18next";
import { AppHeader } from "@/src/components/layout/app-header";
import { AppPage } from "@/src/components/layout/app-page";

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
