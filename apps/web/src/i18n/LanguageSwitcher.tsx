import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation("common");

  const toggleLang = () => {
    const next = i18n.language === "zh" ? "en" : "zh";
    i18n.changeLanguage(next);
  };

  return (
    <button
      type="button"
      onClick={toggleLang}
      title={t("language.switch")}
      className={[
        "flex items-center gap-1 px-2 py-1.5 rounded-[var(--radius)]",
        "text-[13px] text-text-dim",
        "hover:bg-surface-elevated hover:text-text-default",
        "transition-colors duration-100 cursor-pointer",
      ].join(" ")}
    >
      <Globe className="w-3.5 h-3.5" />
      <span>{i18n.language === "zh" ? t("language.zh") : t("language.en")}</span>
    </button>
  );
}
