import { Calendar, Eye, FilesIcon, Globe } from "lucide-react";
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
export function TopModeTabs({ topMode, pendingDiffCount = 0, onChange, availableModes }: TopModeTabsProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  const modes = availableModes ?? (["files", "sites", "tasks", "views"] as TopMode[]);

  return (
    <div className="flex items-center gap-0.5 h-9 px-2 border-b border-border/40 flex-shrink-0 bg-surface-1/50 overflow-x-auto scrollbar-none">
      {modes.map((mode, i) => {
        const meta = MODE_META[mode];
        const Icon = meta.icon;
        const isActive = topMode === mode;

        return (
          <span key={mode} className="flex items-center gap-0.5 flex-shrink-0">
            {i > 0 && <span className="chat-composer-divider mx-0.5 flex-shrink-0" aria-hidden />}
            <button
              type="button"
              onClick={() => onChange(mode)}
              className={cn(
                "relative flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs whitespace-nowrap flex-shrink-0 transition-colors",
                isActive
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-muted hover:bg-surface-2/60 hover:text-text-primary",
              )}
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
  );
}
