import { Calendar, Eye, FilesIcon, Globe, PanelRight, PanelRightDashed, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";
import { cn } from "../../lib/utils";

export type TopMode = "files" | "sites" | "tasks" | "views";

interface TopModeTabsProps {
  topMode: TopMode;
  pendingDiffCount?: number;
  onChange: (mode: TopMode) => void;
  /** 可用模式白名单，未传则全部可用 */
  availableModes?: TopMode[];
  layoutMode?: "floating" | "docked";
  canDock?: boolean;
  onLayoutModeChange?: (mode: "floating" | "docked") => void;
  onClose?: () => void;
}

const MODE_META: Record<TopMode, { icon: typeof FilesIcon; labelKey: string }> = {
  files: { icon: FilesIcon, labelKey: "panelMode.files" },
  sites: { icon: Globe, labelKey: "panelMode.sites" },
  tasks: { icon: Calendar, labelKey: "panelMode.tasks" },
  views: { icon: Eye, labelKey: "panelMode.views" },
};

/**
 * TopModeTabs —— ArtifactsPanel 顶部的一级 tab 栏。
 * 通过 availableModes 白名单控制哪些 tab 显示。
 */
export function TopModeTabs({
  topMode,
  pendingDiffCount = 0,
  onChange,
  availableModes,
  layoutMode = "floating",
  canDock = true,
  onLayoutModeChange,
  onClose,
}: TopModeTabsProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  const modes = availableModes ?? (["files", "sites", "tasks", "views"] as TopMode[]);

  return (
    <div className="artifacts-mode-bar">
      <div className="artifacts-mode-bar__tabs" role="tablist" aria-label={t("panelMode.panelTabs")}>
        {modes.map((mode) => {
          const meta = MODE_META[mode];
          const Icon = meta.icon;
          const isActive = topMode === mode;

          return (
            <span key={mode} className="flex items-center flex-shrink-0">
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onChange(mode)}
                className={cn("artifacts-mode-tab", isActive && "is-active")}
                title={t(meta.labelKey)}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{t(meta.labelKey)}</span>
                {mode === "files" && pendingDiffCount > 0 && topMode !== "files" && (
                  <span
                    className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-orange-500 text-white text-[10px] font-semibold leading-none"
                    title={t("panelMode.pendingDiff", { count: pendingDiffCount })}
                  >
                    {pendingDiffCount > 99 ? "99+" : pendingDiffCount}
                  </span>
                )}
              </button>
            </span>
          );
        })}
      </div>
      <div className="artifacts-mode-bar__actions">
        {canDock && onLayoutModeChange && (
          <button
            type="button"
            className="artifacts-layout-button"
            onClick={() => onLayoutModeChange(layoutMode === "floating" ? "docked" : "floating")}
            aria-label={t(layoutMode === "floating" ? "panelMode.dock" : "panelMode.float")}
            title={t(layoutMode === "floating" ? "panelMode.dock" : "panelMode.float")}
          >
            {layoutMode === "floating" ? <PanelRightDashed aria-hidden /> : <PanelRight aria-hidden />}
            <span>{t(layoutMode === "floating" ? "panelMode.floating" : "panelMode.docked")}</span>
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className="artifacts-close-button"
            onClick={onClose}
            aria-label={t("panelMode.close")}
            title={t("panelMode.close")}
          >
            <X aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
