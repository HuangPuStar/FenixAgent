// shell-navigation.ts
// WebShell 的导航装配**纯逻辑**：分组归属、组内顺序与运行时裁剪。
//
// **所有权**（§1.6 T11 用户裁定「Shell 声明分组与顺序」）：分组定义与组间顺序属应用壳，写在本文件的
// `SHELL_NAV_GROUPS`；导航项的载荷（id / groupId / order / ns / labelKey / icon）由各资源包在
// `packages/<pkg>/web/contribution.ts` 声明，经 `apps/generated/web-contributions.ts` 静态装配进来。
// 资源模块不得反向决定全局布局（standards §4.1），因此本文件出现未知 `groupId` 时直接失败而不是
// 静默丢弃——丢掉一个导航项会让对应页面在控制台里彻底不可达，而这类漂移只有两端对账才看得出来。
//
// **为什么是纯逻辑**：装配结果与翻译、请求无关，可以在没有 React / i18next 的测试里对账
// （`apps/web/src/__tests__/shell-navigation.test.ts` 用真实产物逐项比对迁移前的侧栏）。取译文与
// 运行时裁剪的接线在 `./use-shell-navigation.ts`，渲染在 `./ShellNavigation.tsx`。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import type { LucideIcon } from "lucide-react";
import { generatedWebContributions } from "../../../generated/web-contributions";

/**
 * Shell 持有的导航分组：ID 与组间顺序。标签走宿主 `sidebar` 字典（`navGroup*` 键）。
 *
 * 组间顺序即本数组顺序；新增分组要同时改这里与其宿主字典键，两端由本文件的装配校验与
 * `shell-navigation.test.ts` 守护。
 */
export const SHELL_NAV_GROUPS = [
  { id: "core", labelKey: "navGroupCore" },
  { id: "config", labelKey: "navGroupConfig" },
] as const;

/** 一个侧栏导航项（Shell 装配后的形状；`ns` 供渲染处 `t(labelKey, { ns })` 取值）。 */
export interface ShellNavEntry {
  readonly id: string;
  readonly labelKey: string;
  readonly ns: string;
  readonly icon: LucideIcon;
}

/** 未翻译的分组：分组标签待 `t()` 解析，项来自产物。 */
export interface ShellNavGroupDefinition {
  readonly id: string;
  readonly labelKey: string;
  readonly items: readonly ShellNavEntry[];
}

/** 已翻译的分组（渲染用）。 */
export interface ShellNavGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly ShellNavEntry[];
}

/** 组内声明的 `order` 与其项。 */
interface OrderedEntry {
  readonly order: number;
  readonly entry: ShellNavEntry;
}

/**
 * 把产物里的导航声明按 Shell 的分组表归并、组内按 `order` 升序排列。
 *
 * 两处失败条件都是**构建期就该发现**的声明错误，而不是运行期可恢复状态：
 *
 * - 未知 `groupId`：分组表由 Shell 持有，包声明了 Shell 不认识的分组说明两端已漂移；
 * - 组内 `order` 重复：`order` 是组内唯一排序键（不再有「包 ID 兜底」——导航项不携带包身份，
 *   产物顺序又只是 profile 的 `web` 列表顺序，拿它兜底等于让版式随装配清单变化）。
 *
 * 出错时抛异常而不是降级：控制台在装配期就停摆，比少一项导航（页面不可达且无任何提示）更容易定位。
 * 这两条不变量同时由 `shell-navigation.test.ts` 按真实产物断言，正常构建下这里的抛错不可达。
 */
export function assembleNavGroups(contributions: readonly WebAppContribution[]): readonly ShellNavGroupDefinition[] {
  const grouped = new Map<string, OrderedEntry[]>();
  for (const contribution of contributions) {
    for (const item of contribution.navigation ?? []) {
      const ordered: OrderedEntry = {
        order: item.order,
        entry: { icon: item.icon, id: item.id, labelKey: item.labelKey, ns: item.ns },
      };
      const bucket = grouped.get(item.groupId);
      if (bucket) {
        bucket.push(ordered);
      } else {
        grouped.set(item.groupId, [ordered]);
      }
    }
  }

  const knownGroupIds = new Set<string>(SHELL_NAV_GROUPS.map((group) => group.id));
  for (const groupId of grouped.keys()) {
    if (!knownGroupIds.has(groupId)) {
      throw new Error(
        `WebShell 收到未声明的导航分组 "${groupId}"：分组由 Shell 持有（SHELL_NAV_GROUPS），` +
          "资源包的 contribution 不得自行引入新分组",
      );
    }
  }

  return SHELL_NAV_GROUPS.map((group) => {
    const ordered = [...(grouped.get(group.id) ?? [])].sort((left, right) => left.order - right.order);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous && current && previous.order === current.order) {
        throw new Error(
          `导航项 ${previous.entry.id} 与 ${current.entry.id} 在分组 "${group.id}" 内声明了相同的 order ` +
            `${current.order}：同组内 order 必须唯一`,
        );
      }
    }
    return { id: group.id, items: ordered.map((item) => item.entry), labelKey: group.labelKey };
  });
}

/**
 * 当前装配 profile 选定的导航分组（模块加载时算一次）。
 *
 * 产物是构建期常量（`apps/generated/web-contributions.ts` 只含静态 import），因此装配结果同样是常量：
 * 每个页面渲染都重算一次既无收益，也会让「未声明分组」这类声明错误被推迟到用户点击时才暴露。
 */
export const ASSEMBLED_NAV_GROUPS: readonly ShellNavGroupDefinition[] = assembleNavGroups(generatedWebContributions);

/**
 * 按隐藏列表（`sidebarConfigApi` 的 `hiddenTabs`）裁剪导航项，并移除因此变空的分组。
 *
 * 隐藏列表是**运行时**配置（服务端按用户/组织下发），与构建期的分组表互不重叠：前者只能删项，
 * 不能增项、改序或改分组。分组与项的相对顺序都是版式契约，过滤不得重排；分组标签、项目
 * `labelKey` 与分组 `id` 都不参与匹配——匹配键只有导航项的 `id`。
 *
 * 约束只用 `{ id }` 而不是完整的 `ShellNavEntry`：本函数是纯集合运算，测试不需要为此构造图标与命名空间。
 */
export function filterNavGroups<T extends { id: string; items: readonly { id: string }[] }>(
  groups: T[],
  hiddenTabs: string[],
): T[] {
  const hiddenTabSet = new Set(hiddenTabs);
  return (
    groups.map((group) => ({
      ...group,
      items: group.items.filter((item) => !hiddenTabSet.has(item.id)),
    })) as T[]
  ).filter((group) => group.items.length > 0);
}
