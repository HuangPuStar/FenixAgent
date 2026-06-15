import { useTranslation } from "react-i18next";
import { AgentPageHeader } from "../shared/AgentPageHeader";

export function AgentDashboardPage() {
  const { t } = useTranslation("dashboard");

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="flex flex-col items-center justify-center py-16 text-text-muted">
        <p className="text-sm">{t("welcome")}</p>
      </div>
    </div>
  );
}
