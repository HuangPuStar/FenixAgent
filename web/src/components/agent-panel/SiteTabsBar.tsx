import { Globe, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";
import { cn } from "../../lib/utils";

interface SiteEntry {
  id: string;
  name: string;
  remoteAppId: string;
}

interface SiteTabsBarProps {
  /** 当前选中的 site id（受控，调用方保证非 null 且在 sites 列表内） */
  activeSiteId: string;
  /** site 列表，按绑定顺序排列 */
  sites: SiteEntry[];
  /** 切换 site 的回调，参数是目标 site 的 id */
  onChange: (siteId: string) => void;
  /** 末尾 + 按钮点击，由调用方打开 MountSiteDialog */
  onMountClick: () => void;
  /** 单个 site tab 上的 × 按钮点击，由调用方处理 confirm 流程 */
  onUnmountClick: (siteId: string) => void;
}

/**
 * SiteTabsBar —— ArtifactsPanel 内 Sites 模式下的二级 tab 栏。
 *
 * 仅在一级模式为 "sites" 时由 ArtifactsPanel 挂载，负责在多个绑定的 site 之间
 * 切换 activeSiteId。与一级 TopModeTabs 解耦：本组件不关心"现在是不是 Sites 模式"，
 * 只关心"在 sites 列表里选哪一个"。
 *
 * 末尾固定一个 + 按钮作为挂载入口；每个 site tab 右侧有 × 卸载按钮（hover 显示）。
 * × 点击不立即解绑——confirm 流程由调用方（ArtifactsPanel）统一管理，避免组件内嵌
 * dialog 造成状态混乱。
 *
 * 不接收 pendingDiffCount：角标只挂在一级 Files tab 上，二级切换也不清零
 * （用户仍在 Sites 区浏览，没回 Files，角标应继续累计）。
 */
export function SiteTabsBar({ activeSiteId, sites, onChange, onMountClick, onUnmountClick }: SiteTabsBarProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  return (
    <div
      className="flex items-center gap-0.5 h-9 px-2 border-b border-border/40 flex-shrink-0 bg-surface-1/50 overflow-x-auto scrollbar-none"
      aria-label={t("panelMode.sitesTabAriaLabel")}
      role="tablist"
    >
      {sites.map((site) => {
        const isActive = site.id === activeSiteId;
        return (
          <div
            key={site.id}
            className={cn(
              "group/tab flex items-center gap-1 pl-2.5 pr-1 h-7 rounded-md text-xs whitespace-nowrap flex-shrink-0 transition-colors max-w-[180px]",
              isActive
                ? "bg-surface-2 text-text-primary"
                : "text-text-muted hover:bg-surface-2/60 hover:text-text-primary",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(site.id)}
              className="flex items-center gap-1.5 min-w-0 flex-1"
              title={site.name}
            >
              <Globe className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{site.name}</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUnmountClick(site.id);
              }}
              className={cn(
                "flex-shrink-0 flex items-center justify-center h-5 w-5 rounded transition-colors",
                // hover tab 时才显示 ×，避免视觉噪音；激活 tab 始终显示让用户知道可卸载
                isActive
                  ? "opacity-100 hover:bg-border/40"
                  : "opacity-0 group-hover/tab:opacity-100 hover:bg-border/40",
              )}
              title={t("panelMode.unmountSite")}
              aria-label={t("panelMode.unmountSiteAriaLabel")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}

      {/* 末尾 + 按钮：挂载入口。视觉比 site tab 更弱，提示"操作"而非"选项" */}
      <button
        type="button"
        onClick={onMountClick}
        className="flex items-center justify-center h-7 w-7 rounded-md text-xs flex-shrink-0 text-text-muted hover:bg-surface-2/60 hover:text-text-primary transition-colors"
        title={t("panelMode.mountSite")}
        aria-label={t("panelMode.mountSiteAriaLabel")}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
