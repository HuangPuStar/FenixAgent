import { FilesIcon, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";
import { cn } from "../../lib/utils";

export type PanelMode = { kind: "files" } | { kind: "site"; siteAppId: string; name: string; remoteAppId: string };

interface PanelModeTabsProps {
  mode: PanelMode;
  sites: Array<{ id: string; name: string; remoteAppId: string }>;
  onChange: (mode: PanelMode) => void;
  /**
   * 用户在 Site 模式时累计的未读 diff 文件数。
   * 在 Files tab 上以角标显示，提示用户「有 N 个新文件改动」。
   * 用户主动切回 Files 时由调用方清零。
   */
  pendingDiffCount?: number;
}

/**
 * PanelModeTabs —— ArtifactsPanel 顶部的一级 tab 栏：Files / 每个 Site。
 *
 * Files tab 永远在最左（默认激活），其后跟随按绑定顺序排列的 sites。
 * 与下方的 FileTabsBar（文件级 tab）解耦：本组件决定"显示文件区还是某个 site"，
 * FileTabsBar 只在 Files 模式下负责文件级 tab 切换。
 *
 * 切换 tab 时只显示一种 —— Files 模式下隐藏所有 site iframe；Site 模式下
 * 隐藏整个文件区（FileTabsBar + PreviewTab + FileTreeTab）。
 *
 * 当用户在 Site 模式下 agent 产生了新的 diff 文件，Files tab 会显示 pendingDiffCount
 * 角标，让用户知道有未看的新改动，由用户主动点击切回 Files。
 */
export function PanelModeTabs({ mode, sites, onChange, pendingDiffCount = 0 }: PanelModeTabsProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  return (
    <div className="flex items-center gap-0.5 h-9 px-2 border-b border-border/40 flex-shrink-0 bg-surface-1/50 overflow-x-auto scrollbar-none">
      <button
        type="button"
        onClick={() => onChange({ kind: "files" })}
        className={cn(
          "relative flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs whitespace-nowrap flex-shrink-0 transition-colors",
          mode.kind === "files"
            ? "bg-surface-2 text-text-primary"
            : "text-text-muted hover:bg-surface-2/60 hover:text-text-primary",
        )}
        title={t("panelMode.files")}
      >
        <FilesIcon className="h-3.5 w-3.5" />
        <span>{t("panelMode.files")}</span>
        {/* pending diff 角标：仅当用户在 Site 模式时显示，提醒有新文件改动 */}
        {pendingDiffCount > 0 && mode.kind !== "files" && (
          <span
            className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-orange-500 text-white text-[10px] font-semibold leading-none"
            title={t("panelMode.pendingDiff", { count: pendingDiffCount })}
          >
            {pendingDiffCount > 99 ? "99+" : pendingDiffCount}
          </span>
        )}
      </button>

      {sites.length > 0 && <span className="chat-composer-divider mx-0.5 flex-shrink-0" aria-hidden />}

      {sites.map((site) => {
        const isActive = mode.kind === "site" && mode.siteAppId === site.id;
        return (
          <button
            key={site.id}
            type="button"
            onClick={() =>
              onChange({
                kind: "site",
                siteAppId: site.id,
                name: site.name,
                remoteAppId: site.remoteAppId,
              })
            }
            className={cn(
              "flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs whitespace-nowrap flex-shrink-0 transition-colors max-w-[160px]",
              isActive
                ? "bg-surface-2 text-text-primary"
                : "text-text-muted hover:bg-surface-2/60 hover:text-text-primary",
            )}
            title={site.name}
          >
            <Globe className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">{site.name}</span>
          </button>
        );
      })}
    </div>
  );
}
