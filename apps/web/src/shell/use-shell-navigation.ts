// use-shell-navigation.ts
// 侧栏导航的运行时接线：取分组译文、取用户的隐藏列表，再交给纯逻辑裁剪。
//
// 三段分工：装配（分组归属与组内顺序）在 `./shell-navigation.ts`，翻译与取数在这里，渲染在
// `./ShellNavigation.tsx`。**取数只换来一个隐藏列表**——它是服务端按用户/组织下发的运行时偏好，
// 与构建期的分组表互不重叠（后者是版式契约，`hiddenTabs` 只能删项）。
//
// `sidebarConfigApi` 由 `@fenix/agent-config/web` 提供：表与协议面属该包，但被裁剪的是 Shell 装配出的
// 导航，所以裁剪逻辑与这份接线留在 Shell 一侧（判定见 `./shell-navigation.ts` 的文件头）。

import { sidebarConfigApi } from "@fenix/agent-config/web";
import { useRequest } from "ahooks";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { ASSEMBLED_NAV_GROUPS, filterNavGroups, type ShellNavGroup } from "./shell-navigation";

/**
 * 当前用户可见的侧栏导航分组（标签已翻译）。
 *
 * 分组标签走宿主 `sidebar` 字典（`SHELL_NAV_GROUPS` 只写 labelKey），导航项文案走**各自包的字典**
 * ——`t(labelKey, { ns })`，字典由宿主 i18n 在启动时集中登记，因此这里不需要认识任何包。
 *
 * 隐藏列表取不到时按「无隐藏项」处理：裁剪是可选偏好，一次失败的请求不该让整条侧栏消失。缓存键与
 * 陈旧时间沿用迁移前的取值，行为与旧实现逐字一致。
 */
export function useShellNavigation(): ShellNavGroup[] {
  const { t } = useTranslation(NS.SIDEBAR);
  const { data } = useRequest(
    async () => {
      const response = await sidebarConfigApi.get();
      return response.success ? (response.data?.hiddenTabs ?? []) : [];
    },
    {
      cacheKey: "sidebar-config",
      staleTime: 60_000,
    },
  );

  const translatedGroups = ASSEMBLED_NAV_GROUPS.map((group) => ({
    id: group.id,
    label: t(group.labelKey),
    items: group.items,
  }));

  return filterNavGroups(translatedGroups, data ?? []);
}
