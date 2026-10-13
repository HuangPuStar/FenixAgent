import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { useTranslation } from "react-i18next";
import { DASHBOARD_NS } from "../../../i18n/namespace";

/** Agent 面板的概览页：`/agent/dashboard`，当前只有标题区与一行引导文案。 */
export function AgentDashboardPage() {
  const { t } = useTranslation(DASHBOARD_NS);

  return (
    <AppPage>
      <AppHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="flex flex-col items-center justify-center py-16 text-text-muted">
        <p className="text-sm">{t("welcome")}</p>
      </div>
    </AppPage>
  );
}
