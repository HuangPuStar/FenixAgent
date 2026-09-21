// WebShell 导航装配的契约测试（§1.6 T11d）。
//
// 装配的输入是构建期产物 `apps/generated/web-contributions.ts`（9 个包、14 项导航）。本文件守三件事：
//
// 1. **迁移前后逐项一致**：真实产物装配出的分组、组序、项序必须与迁移前的宿主
//    `SIDEBAR_NAV_GROUPS` 完全相同。这是本次所有权搬迁唯一的用户可见契约，错了就是侧栏乱序或丢项。
// 2. **失败条件必须失败**：未声明的分组、组内重复 `order` 都是声明漂移，装配期就要停摆。
// 3. **裁剪只删项**：`hiddenTabs` 是运行时配置，不能改序、改分组，也不能把空组留在界面上。

import { describe, expect, test } from "bun:test";

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { FileText } from "lucide-react";

import { ASSEMBLED_NAV_GROUPS, assembleNavGroups, filterNavGroups } from "../shell/shell-navigation";

/** 迁移前宿主 `SIDEBAR_NAV_GROUPS` 的逐项快照（分组 id → 组内项 id，顺序即显示顺序）。 */
const PRE_MIGRATION_NAV: readonly (readonly [string, readonly string[]])[] = [
  ["core", ["home", "agents", "workflow", "vertical-models"]],
  [
    "config",
    [
      "models",
      "algorithms",
      "skills",
      "knowledge-bases",
      "mcp",
      "tasks",
      "memories",
      "sites",
      "organizations",
      "apikeys",
    ],
  ],
];

function groupIds(groups: readonly { id: string; items: readonly { id: string }[] }[]): string[][] {
  return groups.map((group) => group.items.map((item) => item.id));
}

/** 构造一项最小贡献；`icon` 只需是 lucide 组件，壳不解释它的语义。 */
function contribution(navigation: readonly { id: string; groupId: string; order: number }[]): WebAppContribution {
  return {
    navigation: navigation.map((item) => ({
      ...item,
      icon: FileText,
      labelKey: `nav.${item.id}`,
      ns: "test",
    })),
  };
}

describe("WebShell 导航装配", () => {
  // 侧栏的分组、组序与项序是用户可见契约：所有权从宿主旧表搬到产物之后必须逐项相同。
  test("真实产物装配出的导航与迁移前逐项一致", () => {
    expect(ASSEMBLED_NAV_GROUPS.map((group) => group.id)).toEqual(PRE_MIGRATION_NAV.map(([id]) => id));
    expect(groupIds(ASSEMBLED_NAV_GROUPS)).toEqual(PRE_MIGRATION_NAV.map(([, items]) => [...items]));
  });

  // 分组标签的 owner 仍是宿主 `sidebar` 字典：Shell 声明分组时只写 labelKey，译文由渲染处取。
  test("分组标签以 labelKey 形式声明，不由包提供", () => {
    expect(ASSEMBLED_NAV_GROUPS.map((group) => group.labelKey)).toEqual(["navGroupCore", "navGroupConfig"]);
  });

  // 每一项都要带自己的命名空间：Shell 用 t(labelKey, { ns }) 取值，缺 ns 会回退成 key 回显。
  test("每个导航项都携带非空的 ns 与 labelKey", () => {
    for (const group of ASSEMBLED_NAV_GROUPS) {
      for (const item of group.items) {
        expect(item.ns.length, `${item.id} 缺少 ns`).toBeGreaterThan(0);
        expect(item.labelKey.length, `${item.id} 缺少 labelKey`).toBeGreaterThan(0);
      }
    }
  });

  // 组内顺序由 order 决定，与包在产物里的声明先后无关（profile 的 web 列表顺序即包顺序）。
  test("组内按 order 升序，与声明顺序无关", () => {
    const groups = assembleNavGroups([
      contribution([
        { groupId: "core", id: "third", order: 30 },
        { groupId: "core", id: "first", order: 10 },
        { groupId: "core", id: "second", order: 20 },
      ]),
    ]);

    expect(groupIds(groups)).toEqual([["first", "second", "third"], []]);
  });

  // 分组表由 Shell 持有：包声明 Shell 不认识的分组说明两端漂移，必须失败而不是静默丢项。
  test("未声明的分组导致装配失败", () => {
    expect(() => assembleNavGroups([contribution([{ groupId: "ghost", id: "x", order: 10 }])])).toThrow(
      '未声明的导航分组 "ghost"',
    );
  });

  // 同一分组内 order 必须唯一：重复时排序结果取决于实现细节，版式会变得不可预测。
  test("组内 order 重复导致装配失败", () => {
    expect(() =>
      assembleNavGroups([
        contribution([
          { groupId: "core", id: "alpha", order: 10 },
          { groupId: "core", id: "beta", order: 10 },
        ]),
      ]),
    ).toThrow('在分组 "core" 内声明了相同的 order 10');
  });

  // 没有贡献的分组仍然出现（空组由渲染与裁剪决定），保证分组表本身不随贡献内容变化。
  test("无贡献的分组产空组", () => {
    expect(assembleNavGroups([])).toEqual([
      { id: "core", items: [], labelKey: "navGroupCore" },
      { id: "config", items: [], labelKey: "navGroupConfig" },
    ]);
  });
});

describe("WebShell 导航的运行时裁剪", () => {
  // 隐藏项只按 id 匹配，命中即从所在组消失，其余项与组序原样保留。
  test("隐藏单项后其余项与组序不变", () => {
    const filtered = filterNavGroups([...ASSEMBLED_NAV_GROUPS], ["mcp"]);

    expect(groupIds(filtered)[0]).toEqual([...PRE_MIGRATION_NAV[0][1]]);
    expect(groupIds(filtered)[1]).toEqual([
      "models",
      "algorithms",
      "skills",
      "knowledge-bases",
      "tasks",
      "memories",
      "sites",
      "organizations",
      "apikeys",
    ]);
  });

  // 整组被隐藏后不得在界面上留下空标题。
  test("整组隐藏后移除空组", () => {
    const filtered = filterNavGroups([...ASSEMBLED_NAV_GROUPS], ["home", "agents", "workflow", "vertical-models"]);

    expect(filtered.map((group) => group.id)).toEqual(["config"]);
  });
});
