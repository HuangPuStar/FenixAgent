import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { NS } from "../../src/i18n";

export const Route = createFileRoute("/no-access")({
  component: NoAccessPage,
});

function NoAccessPage() {
  const navigate = useNavigate();
  const { t } = useTranslation(NS.COMMON);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold text-text-primary">403</h1>
      <p className="text-sm text-text-muted">{t("no_access")}</p>
      <button
        type="button"
        onClick={() => void navigate({ to: "/agent" })}
        className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90"
      >
        {t("back_home")}
      </button>
    </div>
  );
}
