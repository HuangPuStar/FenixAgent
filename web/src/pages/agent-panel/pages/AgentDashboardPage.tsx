import { useTranslation } from "react-i18next";
import { AgentPageHeader } from "../shared/AgentPageHeader";

export function AgentDashboardPage() {
  const { t } = useTranslation("dashboard");

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-col items-center justify-center py-16 text-text-muted">
          <p className="text-sm">{t("welcome")}</p>
        </div>
      </div>
    </div>
  );
}
