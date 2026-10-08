import { cn } from "@fenix/ui-components/lib/cn";
import { Calendar, Eye, FilesIcon, Globe, PanelRight, PanelRightDashed, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

export type TopMode = "files" | "sites" | "tasks" | "views";

interface TopModeTabsProps {
  topMode: TopMode;
  pendingDiffCount?: number;
  onChange: (mode: TopMode) => void;
  /** 可用模式白名单与显示顺序；由 `ArtifactsPanel` 按 `modulesConfig` 算出（本组件不读配置）。 */
  availableModes: TopMode[];
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
 * TopModeTabs —— ArtifactsPanel 顶部的一级 tab 栏（Files / Sites / Tasks / Views），按 `availableModes`
 * 白名单决定显示哪些 tab、按什么顺序。
 *
 * 归属：`ArtifactsPanel` 的私有件，随它同住 `apps/web/src/pages/agent-panel/artifacts/`（2026-09-28 由
 * `apps/web/src/shell/artifacts/` 归位，见 `ArtifactsPanel.tsx` 文件头）。它只做渲染与回调转发，不取数、
 * 不持有模式之外的业务状态；文案取宿主 `components` 字典（tab 名与布局动作都是宿主面板自己的词条，
 * 站点域的动作词条按 §9.2 由 `ArtifactsPanel` 从 `@fenix/agent-config` 命名空间取）。
 * 交互态（hover / focus-visible / 选中色）与全部几何都在本文件 `className` 里：栏高 44px（`min-h-11`）、
 * 栏体间距 8px（`gap-2`）与左右内边距 10 / 8px（`ps-2.5 pe-2`）、tab 的 44px / 6px / 9px（`h-11` /
 * `gap-1.5` / `px-2.25`）与 12px 字号（`text-xs`）、动作按钮的 30px（`h-7.5`）/ 5px（`gap-1.25`）/
 * 圆角 6px（`rounded-md`）/ 7px（`px-1.75`）与三处图标 15px（`size-3.75`）——刻度（`--spacing` /
 * `--radius-*` / `--text-*`）已在 `@theme` 按 px 落地，工具类写的就是设计值。仍留在 CSS 的只剩伪元素
 * 下划线、滚动条隐藏与非标准断点（见 `src/index.css` 的「宿主壳残余样式」段）。
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

  return (
    <div className="artifacts-mode-bar flex shrink-0 items-stretch justify-between min-h-11 gap-2 ps-2.5 pe-2 border-b border-border-subtle bg-surface-1">
      <div
        className="artifacts-mode-bar__tabs flex min-w-0 items-stretch gap-0.5 overflow-x-auto"
        role="tablist"
        aria-label={t("panelMode.panelTabs")}
      >
        {availableModes.map((mode) => {
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
                className={cn(
                  "artifacts-mode-tab relative inline-flex items-center h-11 gap-1.5 px-2.25 whitespace-nowrap text-xs text-text-muted hover:text-text-primary",
                  isActive && "is-active text-text-primary",
                )}
                title={t(meta.labelKey)}
              >
                <Icon className="size-3.75" />
                <span>{t(meta.labelKey)}</span>
                {mode === "files" && pendingDiffCount > 0 && topMode !== "files" && (
                  <span
                    className="ml-0.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-orange-500 text-white text-3xs font-semibold leading-none"
                    title={t("panelMode.pendingDiff", { count: pendingDiffCount })}
                  >
                    {/* 角标只显示到 99（真实条数在 `title` 里），溢出标记走字典——§9.3 要求数字按当前 locale 取。 */}
                    {pendingDiffCount > 99 ? t("panelMode.pendingDiffOverflow") : pendingDiffCount}
                  </span>
                )}
              </button>
            </span>
          );
        })}
      </div>
      <div className="artifacts-mode-bar__actions flex shrink-0 items-center gap-0.5">
        {canDock && onLayoutModeChange && (
          <button
            type="button"
            className="artifacts-layout-button inline-flex items-center justify-center h-7.5 gap-1.25 px-1.75 rounded-md text-xs text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:text-text-primary"
            onClick={() => onLayoutModeChange(layoutMode === "floating" ? "docked" : "floating")}
            aria-label={t(layoutMode === "floating" ? "panelMode.dock" : "panelMode.float")}
            title={t(layoutMode === "floating" ? "panelMode.dock" : "panelMode.float")}
          >
            {layoutMode === "floating" ? (
              <PanelRightDashed className="size-3.75" aria-hidden />
            ) : (
              <PanelRight className="size-3.75" aria-hidden />
            )}
            <span>{t(layoutMode === "floating" ? "panelMode.floating" : "panelMode.docked")}</span>
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className="artifacts-close-button inline-flex items-center justify-center h-7.5 w-7.5 rounded-md text-xs text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:text-text-primary"
            onClick={onClose}
            aria-label={t("panelMode.close")}
            title={t("panelMode.close")}
          >
            <X className="size-3.75" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
