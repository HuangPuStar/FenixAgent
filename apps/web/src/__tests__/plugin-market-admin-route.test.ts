// 「插件市场的管理面在管理台」的契约用例（2026-09-24）。
//
// 分界：**用户看得到市场，管理在管理台**。控制台那一 tab（`/agent/mcp?tab=npm`）是只读浏览面；发布、下架与
// 恢复只在 `/admin/plugin-market`，凭据是系统 master key（`/api/system/plugin-market/*`）。这条分界横跨宿主
// 与包两侧——路由壳、管理台侧栏、字典键——包内用例看不见它，因此在这里钉住三件事：
//
// 1. **路由**：真实路由表里有 `/admin/plugin-market`；控制台的合并页仍只装配只读的浏览面；
// 2. **导航**：管理台侧栏有指向该路由的一项，取键 `admin.nav` 且按包导出的命名空间取值；
// 3. **字典**：该键在包的两种语言里都在（宿主按 `ns` 取值，缺键时界面上只会回显 key 本身）。
//
// 源码断言一律匹配**调用点字面量**（`to: "/admin/plugin-market"`、`m.AdminPluginMarketPage`）：这些形态在
// 注释里不会出现，因此注释解释了这个契约也不会让断言空转（与 `plugin-market-tab-merge.test.ts` 同口径）。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PLUGIN_MARKET_NS, pluginMarketResources } from "@fenix/resource-plugin-market/web/i18n";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";

import { routeTree } from "../routeTree.gen";

const HOST = resolve(import.meta.dir, "..");

/** 应用实际使用的路由表；建法与 `shell-navigation-routes.test.ts` 逐字相同（内存 history + `isServer` 显式置真）。 */
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/admin/plugin-market"] }),
  isServer: true,
});

/** 管理台插件市场页的宿主路由壳。 */
const ADMIN_ROUTE_SOURCE = readFileSync(join(HOST, "routes/admin/plugin-market.tsx"), "utf8");
/** 管理台布局（侧栏导航项在这里声明）。 */
const ADMIN_LAYOUT_SOURCE = readFileSync(join(HOST, "routes/admin.tsx"), "utf8");
/** 控制台的合并页（MCP 市场 + npm 市场两个 tab）。 */
const CONSOLE_ROUTE_SOURCE = readFileSync(join(HOST, "routes/agent/_panel/mcp.tsx"), "utf8");

describe("插件市场管理面：管理台入口", () => {
  // 业务意图：管理的落点是管理台的一条真实路由。路由不在表里时，侧栏项点进去是空白页，而类型检查不会报错。
  test("真实路由表里有 /admin/plugin-market", () => {
    expect("/admin/plugin-market" in router.routesByPath).toBe(true);
  });

  // 业务意图：管理页必须懒加载包的管理面出口（`AdminPluginMarketPage`），而不是把逻辑复制到宿主。
  test("管理台路由懒加载包的管理页", () => {
    expect(ADMIN_ROUTE_SOURCE).toContain('import("@fenix/resource-plugin-market/web")');
    expect(ADMIN_ROUTE_SOURCE).toContain("m.AdminPluginMarketPage");
  });

  // 业务意图：控制台那一面**只**装配只读浏览面。管理页被顺手挂进控制台时，一个已认证用户就能看到写按钮——
  // 而写路径的判据是系统 master key，界面上的按钮点下去只会 401。
  test("控制台那一面不装配管理页", () => {
    expect(CONSOLE_ROUTE_SOURCE).toContain("m.PluginMarketPage");
    expect(CONSOLE_ROUTE_SOURCE).not.toContain("AdminPluginMarketPage");
  });
});

describe("插件市场管理面：管理台导航项", () => {
  // 业务意图：导航项是唯一入口。少了它，管理页只能靠手敲 URL 到达。
  test("管理台侧栏有指向该路由的一项", () => {
    expect(ADMIN_LAYOUT_SOURCE).toContain('to: "/admin/plugin-market"');
  });

  // 业务意图：跨包页面的文案 owner 是包本身——`ns` 必须取包导出的常量，键必须落在包字典里。按 observer
  // 命名空间读（本布局的默认）会直接把 key 回显到侧栏上。
  test("导航项按包导出的命名空间与键取值", () => {
    expect(ADMIN_LAYOUT_SOURCE).toContain('labelKey: "admin.nav"');
    expect(ADMIN_LAYOUT_SOURCE).toContain("ns: PLUGIN_MARKET_NS");
    expect(ADMIN_LAYOUT_SOURCE).toContain("PLUGIN_MARKET_NS");
  });

  // 业务意图：命名空间常量是壳取值用的键，包改名而宿主没跟上时取到的是整份空字典。
  test("导航项文案在包的两种语言里都在", () => {
    expect(PLUGIN_MARKET_NS).toBe("pluginMarket");
    expect(pluginMarketResources.en.admin.nav).toBeTruthy();
    expect(pluginMarketResources.zh.admin.nav).toBeTruthy();
  });
});
