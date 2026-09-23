// 侧栏导航 `id` 与路由目标的一致性守卫（前端规范 §2.6 装配链、§2.7）。
//
// 由来：导航项的 `id` 同时是路由目标（Shell 组装成 `/agent/<id>`，契约见
// `@fenix/web-runtime/shell/contribution`），但 `id` 由各包在自己的 `web/contribution.ts` 里声明，
// 对应的路由壳却要宿主另建 `routes/agent/_panel/<id>.tsx`。把 `skills` 打成 `skill`、或新增导航项
// 却忘了建路由壳时，装配期都能过——`shell-navigation.test.ts` 守的是「与迁移前快照逐项一致」，
// 而新增导航项本来就要求同步那份快照，改完就再也看不出路由缺没缺——只有用户点下去才发现是 404。
//
// 本文件把这条不变量钉在**两端真实产物**上，不另写「id → 路径」映射表：
//
// - 导航侧：`ASSEMBLED_NAV_GROUPS`（`apps/generated/web-contributions.ts` 经 Shell 装配的结果，
//   与侧栏渲染同源）；
// - 路由侧：`routeTree`（Vite 插件由 `routes/` 生成、应用实际使用的那张路由表）；
// - 路径拼法：与 `DefaultAppShell` 共用 `panelRoutePath`，避免第三处再写一遍前缀。

import { describe, expect, test } from "bun:test";

import { createMemoryHistory, createRouter } from "@tanstack/react-router";

import { routeTree } from "../routeTree.gen";
import { ASSEMBLED_NAV_GROUPS, PANEL_ROUTE_PREFIX, panelRoutePath } from "../shell/shell-navigation";

/**
 * 应用实际使用的路由表，只换掉两处与浏览器相关的东西：history 用内存实现（`createRouter` 要有 history
 * 才建路由索引），`isServer` 显式置真——用例进程没有 `document`，不置真时 router-core 会按浏览器分支去
 * 读全局 `history`（滚动恢复），而全目录一起跑时别的用例可能已注入过 `window`，结果随加载顺序漂移。
 *
 * `basepath` 之类与路由全路径无关，这里全按默认：断言只读 `routesByPath` 的键。
 */
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/agent/home"] }),
  isServer: true,
});

/** 侧栏全部导航项的 id（分组归属与组内顺序由 `shell-navigation.test.ts` 守着，这里只关心可达性）。 */
const NAV_IDS = ASSEMBLED_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));

describe("侧栏导航 id 与路由目标", () => {
  // 业务意图：侧栏每一项点下去都必须落到真实路由上。id 打错、或路由壳被改名/删除时在装配期就失败，
  // 而不是等用户点出一个 404。
  test("每个导航 id 都能在真实路由表里找到 /agent/<id>", () => {
    expect(NAV_IDS.length).toBeGreaterThan(0);

    const missing = NAV_IDS.filter((id) => !(panelRoutePath(id) in router.routesByPath));

    expect(missing).toEqual([]);
  });

  // 业务意图：上面那条断言不能空转——路由表必须只认真实存在的路径，否则「全绿」什么也没证明。
  test("路由表不认识不存在的面板页路径", () => {
    expect(`${PANEL_ROUTE_PREFIX}not-a-panel-page` in router.routesByPath).toBe(false);
  });
});
