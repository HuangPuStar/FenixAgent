import { Calendar, FilesIcon, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";
import { cn } from "../../lib/utils";

export type TopMode = "files" | "sites" | "tasks";

interface TopModeTabsProps {
  /** 当前一级模式：Files 显示文件区，Sites 显示二级 site tab + iframe（或空状态） */
  topMode: TopMode;
  /**
   * 用户在 Sites 模式时累计的未读 diff 文件数。
   * 在 Files tab 上以角标显示，提示用户「有 N 个新文件改动」。
   * 用户主动切回 Files 时由调用方清零。
   */
  pendingDiffCount?: number;
  onChange: (mode: TopMode) => void;
}

/**
 * TopModeTabs —— ArtifactsPanel 顶部的一级 tab 栏：Files / Sites 互斥二选一。
 *
 * 与下方二级 SiteTabsBar 解耦：本组件只决定"显示文件区还是站点区"，
 * 具体选哪个 site 由 SiteTabsBar（仅在 sites 模式下挂载）负责。
 *
 * Files tab 永远在最左（默认激活）。pending diff 角标仅当用户在 Sites 模式时
 * 挂在 Files button 上，让用户知道有未看的新改动，由用户主动点击切回 Files。
 *
 * Sites button 永远可点：未绑定时切过去由 ArtifactsPanel 渲染空状态提示用户去
 * Agent 配置里绑定，让用户知道这个功能存在。
 */
export function TopModeTabs({ topMode, pendingDiffCount = 0, onChange }: TopModeTabsProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  return (
    <div className="flex items-center gap-0.5 h-9 px-2 border-b border-border/40 flex-shrink-0 bg-surface-1/50 overflow-x-auto scrollbar-none">
      <button
        type="button"
        onClick={() => onChange("files")}
        className={cn(
          "relative flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs whitespace-nowrap flex-shrink-0 transition-colors",
          topMode === "files"
            ? "bg-surface-2 text-text-primary"
            : "text-text-muted hover:bg-surface-2/60 hover:text-text-primary",
        )}
        title={t("panelMode.files")}
      >
        <FilesIcon className="h-3.5 w-3.5" />
        <span>{t("panelMode.files")}</span>
        {/* pending diff 角标：仅当用户在 Sites 模式时显示，提醒有新文件改动 */}
        {pendingDiffCount > 0 && topMode !== "files" && (
          <span
            className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-orange-500 text-white text-[10px] font-semibold leading-none"
            title={t("panelMode.pendingDiff", { count: pendingDiffCount })}
          >
            {pendingDiffCount > 99 ? "99+" : pendingDiffCount}
          </span>
        )}
      </button>

      <span className="chat-composer-divider mx-0.5 flex-shrink-0" aria-hidden />

      <button
        type="button"
        onClick={() => onChange("sites")}
        className={cn(
          "flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs whitespace-nowrap flex-shrink-0 transition-colors",
          topMode === "sites"
            ? "bg-surface-2 text-text-primary"
            : "text-text-muted hover:bg-surface-2/60 hover:text-text-primary",
        )}
        title={t("panelMode.sites")}
      >
        <Globe className="h-3.5 w-3.5" />
        <span>{t("panelMode.sites")}</span>
      </button>

      <span className="chat-composer-divider mx-0.5 flex-shrink-0" aria-hidden />

      <button
        type="button"
        onClick={() => onChange("tasks")}
        className={cn(
          "flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs whitespace-nowrap flex-shrink-0 transition-colors",
          topMode === "tasks"
            ? "bg-surface-2 text-text-primary"
            : "text-text-muted hover:bg-surface-2/60 hover:text-text-primary",
        )}
        title={t("panelMode.tasks")}
      >
        <Calendar className="h-3.5 w-3.5" />
        <span>{t("panelMode.tasks")}</span>
      </button>
    </div>
  );
}
