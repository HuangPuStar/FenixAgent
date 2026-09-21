// ShellNavigation.tsx
// 侧栏上方的快捷导航：由各资源包的 web contribution 装配而来（装配与裁剪见 `./shell-navigation.ts`）。
//
// **为什么这里没有导航表**：14 项导航的 `id` / 分组 / 组内顺序 / 文案 key 与图标分别由 9 个包在
// `web/contribution.ts` 里声明，Shell 只持有分组表与组间顺序。本文件因此只负责「把装好的东西画出来」，
// 新增一个资源页面不需要动它（§1.6 T11 用户裁定「Shell 声明分组与顺序」）。
//
// 项的文案走 `t(labelKey, { ns })`：包字典在宿主 i18n 启动时集中登记，`ns` 由贡献声明携带，缺它会
// 静默回退成 key 回显（由 `apps/web/src/__tests__/shell-navigation.test.ts` 断言非空）。

import { useTranslation } from "react-i18next";
import { useShellNavigation } from "./use-shell-navigation";

interface ShellNavigationProps {
  /** 当前激活的导航项 id（来自路由状态）。 */
  activeNav: string | null;
  onNavigate: (pageId: string) => void;
}

export function ShellNavigation({ activeNav, onNavigate }: ShellNavigationProps) {
  const { t } = useTranslation();
  const navGroups = useShellNavigation();

  return (
    <div className="agent-sidebar-nav px-2 py-1">
      {navGroups.map((group) => (
        <div className="agent-sidebar-nav-group" key={group.id}>
          <div className="agent-sidebar-section-label">{group.label}</div>
          {group.items.map((item) => {
            const Icon = item.icon;
            const label = t(item.labelKey, { ns: item.ns });
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                title={label}
                className={`agent-sidebar-nav-item flex items-center gap-2 w-full px-3 py-1.5 rounded-[var(--radius)] text-[12px] font-medium transition-all duration-150 cursor-pointer ${
                  isActive
                    ? "active bg-brand-subtle text-brand-light border-l-2 border-brand"
                    : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                }`}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
