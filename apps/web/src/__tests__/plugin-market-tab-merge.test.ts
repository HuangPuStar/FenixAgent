// 「插件市场合并为一个页面的两个 tab」的契约用例（2026-09-23）。
//
// 合并后的形状：侧栏只有一个「插件市场」项（id `mcp` → `/agent/mcp`），页面里 MCP 市场与 npm 私有源
// 市场各占一个 tab，tab 状态在 URL（`?tab=npm`，默认 MCP）。三件事分别守在这里：
//
// 1. **独立入口彻底撤除**：真实路由表里没有 `/agent/plugin-market`，装配出的导航里没有 `plugin-market`
//    项。只删一半（页面没了、路由或导航项还在）时用户点进去是空壳，而装配期、类型检查都不会报错。
// 2. **合并后的页面确实装配了两个市场**：MCP 市场与 npm 市场都从各自包的 `./web` 出口懒加载，
//    npm 那一 tab 的链接带 `tab: "npm"`，且 tab 值取自 URL（刷新与分享链接要停在同一个市场）。
// 3. **tab 文案与地标名两种语言都能取到**：三个 key 都在字典里——i18next 缺键时不报错，只把 key
//    本身画到界面上。
//
// 源码断言一律匹配**调用点字面量**（`tMcp("tabs.mcp")`、`search: { tab: "npm" }`）：这些形态在注释里
// 不会出现，因此注释解释了这个契约也不会让断言空转。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { MCP_NS, mcpResources } from "@fenix/resource-mcp/web/i18n";
import { PLUGIN_MARKET_NS, pluginMarketResources } from "@fenix/resource-plugin-market/web/i18n";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";

import { routeTree } from "../routeTree.gen";
import { ASSEMBLED_NAV_GROUPS, panelRoutePath } from "../shell/shell-navigation";

const HOST = resolve(import.meta.dir, "..");

/**
 * 应用实际使用的路由表；建法与 `shell-navigation-routes.test.ts` 逐字相同（内存 history + `isServer`
 * 显式置真），断言只读 `routesByPath` 的键。
 */
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/agent/mcp"] }),
  isServer: true,
});

/** 侧栏全部导航项的 id。 */
const NAV_IDS = ASSEMBLED_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));

/** 合并后的页面（宿主路由壳）。 */
const MERGED_ROUTE_SOURCE = readFileSync(join(HOST, "routes/agent/_panel/mcp.tsx"), "utf8");

/** 宿主字典里的点号路径键取到值（摊平口径与 `host-i18n.test.ts` 一致）；两份语言都要有。 */
function hostKey(lng: "en" | "zh", path: string): unknown {
  const dictionary = JSON.parse(readFileSync(join(HOST, `i18n/locales/${lng}/components.json`), "utf8")) as Record<
    string,
    unknown
  >;
  return path
    .split(".")
    .reduce<unknown>(
      (node, segment) => (node && typeof node === "object" ? (node as Record<string, unknown>)[segment] : undefined),
      dictionary,
    );
}

describe("插件市场合并：独立入口已撤除", () => {
  // 业务意图：npm 市场不再是一个侧栏项。路由表里若还留着 `/agent/plugin-market`，那条路由就是个没人能
  // 导航到的空壳；反过来 `mcp` 必须在表里，否则下面那条断言会因路由表整体抽风而空转。
  test("真实路由表里没有独立市场路由，合并后的页面路由仍在", () => {
    expect(panelRoutePath("mcp") in router.routesByPath).toBe(true);
    expect(panelRoutePath("plugin-market") in router.routesByPath).toBe(false);
  });

  // 业务意图：侧栏只有一个市场入口。`mcp` 是合并后的那个（文案仍是「插件市场」）；
  // 第二个入口一旦复活就是两个「插件市场」并列。
  test("装配出的导航里有 mcp 项、没有 plugin-market 项", () => {
    expect(NAV_IDS).toContain("mcp");
    expect(NAV_IDS).not.toContain("plugin-market");
  });
});

describe("插件市场合并：两个市场各自装配", () => {
  // 业务意图：两个 tab 都必须真的被装上。少一个的后果是缓存了旧 chunk 的老客户端点进空白页，
  // 而这一层（谁与谁同页）在包内用例里看不见。
  test("合并后的页面懒加载两个市场的包出口", () => {
    expect(MERGED_ROUTE_SOURCE).toContain('import("@fenix/resource-mcp/web")');
    expect(MERGED_ROUTE_SOURCE).toContain('import("@fenix/resource-plugin-market/web")');
  });

  // 业务意图：tab 的**写**（链接带 `tab=npm`）与**读**（从 URL 取）必须成对：任一侧退回组件 state 都会
  // 让刷新、前进后退与分享链接丢掉「我在哪个市场」。
  test("npm tab 的链接带 tab 参数，tab 值从 URL 读取", () => {
    expect(MERGED_ROUTE_SOURCE).toMatch(/search:\s*\{\s*tab:\s*"npm"\s*\}/);
    expect(MERGED_ROUTE_SOURCE).toContain("useSearch(");
  });
});

describe("插件市场合并：tab 文案与地标名", () => {
  // 业务意图：tab 文案的 owner 是各自包（`tabs.mcp` / `tabs.npm`），地标名的 owner 是宿主。
  // 三处缺一，界面上就是 key 回显或一段没有名字的导航区域。
  test("两个市场的 tab 文案在各自的两种语言里都在", () => {
    expect(mcpResources.en.tabs.mcp).toBeTruthy();
    expect(mcpResources.zh.tabs.mcp).toBeTruthy();
    expect(pluginMarketResources.en.tabs.npm).toBeTruthy();
    expect(pluginMarketResources.zh.tabs.npm).toBeTruthy();
  });

  // 业务意图：命名空间常量是壳取值用的键，包改名而宿主没跟上时，取到的是整个字典的空值。
  test("宿主按各包导出的命名空间取值", () => {
    expect(MCP_NS).toBe("mcp");
    expect(PLUGIN_MARKET_NS).toBe("pluginMarket");
    expect(MERGED_ROUTE_SOURCE).toContain("useTranslation(NS.MCP)");
    expect(MERGED_ROUTE_SOURCE).toContain("useTranslation(NS.PLUGIN_MARKET)");
    expect(MERGED_ROUTE_SOURCE).toContain('tMcp("tabs.mcp")');
    expect(MERGED_ROUTE_SOURCE).toContain('tMarket("tabs.npm")');
  });

  test("tab 栏的地标名在宿主字典的两种语言里都在", () => {
    expect(hostKey("en", "marketTabs.label")).toBeTruthy();
    expect(hostKey("zh", "marketTabs.label")).toBeTruthy();
  });
});
