// ShellNavigation.tsx
// 侧栏上方的快捷导航：由各资源包的 web contribution 装配而来（装配与裁剪见 `./shell-navigation.ts`）。
//
// **为什么这里没有导航表**：14 项导航的 `id` / 分组 / 组内顺序 / 文案 key 与图标分别由 9 个包在
// `web/contribution.ts` 里声明，Shell 只持有分组表与组间顺序。本文件因此只负责「把装好的东西画出来」，
// 新增一个资源页面不需要动它（§1.6 T11 用户裁定「Shell 声明分组与顺序」）。
//
// 项的文案走 `t(labelKey, { ns })`：包字典在宿主 i18n 启动时集中登记，`ns` 由贡献声明携带，缺它会
// 静默回退成 key 回显（由 `apps/web/src/__tests__/shell-navigation.test.ts` 断言非空）。
//
// 样式：取值全部在 `className`——刻度（`--spacing` / `--radius-*` / `--text-*` / `--tracking-*`）已在 `@theme`
// 按 px 落地，工具类写的就是设计值（`gap-2.5` = 10px、`rounded-md` = 6px、`text-xs` = 12px、`tracking-*` 为
// 自有字距档），不再按「13px 根字号 → 刻度只渲染名义值 0.8125 倍」的旧口径手写 px。折叠态由 `collapsed`
// （`AgentSidebar` 透传）给**互斥的条件类串**：标签条件渲染，条目的 48px 宽与 10px 内边距在折叠分支里另给
// 一串，不用后代选择器、也不用 `--collapsed` 修饰类的同属性覆写。行高 1.4 与选中态（含内描边）也走互斥
// 条件串（Tailwind 把 `leading-*` 排在 `text-*` 之后，同层后写者胜；`.active` 只再作指示条伪元素的钩子）。
// 仍留在 CSS 的（见 `src/index.css` 的「宿主壳残余样式」段）：滚动条覆写与指示条伪元素两类。

import { useTranslation } from "react-i18next";
import { useShellNavigation } from "./use-shell-navigation";

interface ShellNavigationProps {
  /** 当前激活的导航项 id（来自路由状态）。 */
  activeNav: string | null;
  onNavigate: (pageId: string) => void;
  /** 侧栏折叠态（状态归 `AgentSidebar`）：标签整体不渲染，条目改成一列图标并居中。 */
  collapsed: boolean;
}

export function ShellNavigation({ activeNav, onNavigate, collapsed }: ShellNavigationProps) {
  const { t } = useTranslation();
  const navGroups = useShellNavigation();

  return (
    <div className="agent-sidebar-nav h-full max-h-none overflow-y-auto overflow-x-hidden">
      {navGroups.map((group) => (
        <div className="agent-sidebar-nav-group" key={group.id}>
          {!collapsed && (
            <div className="agent-sidebar-section-label block pt-2.5 px-4 pb-1 text-3xs leading-[1.2] font-bold uppercase tracking-widest text-white/35">
              {group.label}
            </div>
          )}
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
                className={[
                  // 条目几何全在这里：间距 10px（`gap-2.5`）、纵向外边距 1px（`my-px`）。横向铺满由展开支的
                  // `w-full` 担着——`<button>` 的 `width: auto` 是 fit-content，不会自己撑满块级容器；
                  // 2026-09-29 复议：2026-09-28 收口把容器内边距换成条目 `mx-2` 时连同 `w-full` 一起丢了，
                  // 高亮才缩成左边内缩、右边更空的「一小块」。零横向外边距 + `w-full` + 24px 内边距（`px-6`）
                  // 之后，高亮左右都贴到侧栏边缘，内容左缘 `8 + 16 = 24px` 与旧的 `mx-2 px-4` 同值，图标与
                  // 文字位置不动。
                  // 行高 1.4（`leading-[1.4]`）——Tailwind 把 `leading-*` 排在 `text-*` 之后，同层后写者胜，
                  // 不再需要未分层的同属性兜底（2026-09-28 第四批）。
                  "agent-sidebar-nav-item relative flex items-center gap-2.5 my-px font-medium text-xs leading-[1.4] transition-all duration-150 cursor-pointer rounded",
                  // 选中态与悬停态是同一元素的两种互斥状态：改成互斥条件串后不再需要未分层 `.active` 覆写
                  // （原写法要在工具类层里与 `:hover` 变体争同属性）；`.active` 类名保留，只再作指示条伪元素钩子。
                  isActive
                    ? "active text-white bg-white/16 inset-ring-1 inset-ring-white/8"
                    : "text-white/68 hover:bg-white/9 hover:text-white",
                  // 折叠态另给一串内边距与宽度：48px 宽 + 8px 横向外边距 → 与 64px 折叠侧栏
                  // `8 + 48 + 8` 精确咬合（`w-12` = 48px）。宽度与横向外边距都只在这一支里给（展开支是
                  // `w-full` 与零外边距，两支互斥），指示条伪元素的 `left: -8px`（`index.css` 残余段）仍按它算。
                  collapsed
                    ? "agent-sidebar-nav-item--collapsed w-12 min-w-0 justify-center mx-2 px-0 py-2.5"
                    : "w-full px-6 py-1.5",
                ].join(" ")}
              >
                <Icon className="size-4.5 flex-shrink-0" strokeWidth={1.7} />
                {!collapsed && <span>{label}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
