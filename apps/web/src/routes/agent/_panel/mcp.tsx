// 插件市场页：一个侧栏项之下挂两个市场（MCP 插件 / npm 插件），按 tab 切换。
//
// **为什么两个市场是同一页的两个 tab**：它们回答同一个问题（「有哪些插件可以装」），差别只在来源与
// 发布方式；分成两个侧栏项会让「插件市场」这个名字同时指向两个入口。
//
// **为什么 tab 栏在页面标题之上、两个市场各自带着完整的标题区**：npm 市场的标题区里有「发布」按钮，
// 它按列表响应里的 `canPublish` 决定是否渲染，MCP 市场的「新建 Server」按钮也归它自己的弹窗状态。
// 壳不取数（前端规范 §2.7「壳里可以有接线，但不做取数」），因此**标题区连同动作必须留在各自页面里**；
// 壳只持有 tab 状态与 tab 栏这一段接线（与 `ArtifactsPanel` 在面板顶部装配 `TopModeTabs`、各面板自带
// 内部标题区同形）。
//
// tab 状态放 URL（`?tab=npm`）而不是组件 state：刷新、前进后退、分享链接都停在同一个市场，
// 默认值 `mcp` 与侧栏项 `id` 同名（`/agent/mcp` 即 MCP 市场）。文案 owner 仍是各包：
// `mcp.tabs.mcp` 与 `pluginMarket.tabs.npm` 由两个包各自维护，壳只按命名空间取值。

import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { Package, Plug } from "lucide-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";
import { NS } from "@/src/i18n";

const McpMarketPage = lazy(() => import("@fenix/resource-mcp/web").then((m) => ({ default: m.AgentMcpPage })));
const NpmMarketPage = lazy(() =>
  import("@fenix/resource-plugin-market/web").then((m) => ({ default: m.PluginMarketPage })),
);

/** 市场 tab：`mcp` 是默认（无 query 时的落点），`npm` 是 npm 私有源市场的唯一地址。 */
type MarketTab = "mcp" | "npm";

function PluginMarketsPage() {
  const { t: tMcp } = useTranslation(NS.MCP);
  const { t: tMarket } = useTranslation(NS.PLUGIN_MARKET);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const search = useSearch({ strict: false }) as { tab?: string };
  const activeTab: MarketTab = search.tab === "npm" ? "npm" : "mcp";

  const tabs = [
    { id: "mcp" as const, label: tMcp("tabs.mcp"), icon: Plug, search: {} },
    { id: "npm" as const, label: tMarket("tabs.npm"), icon: Package, search: { tab: "npm" } },
  ];

  return (
    // 页面背景与内边距跟 `AppPage` 对齐：tab 栏在 `AppPage` 之外（页面由 tab 内容自带），
    // 两处底色与左边距一致才不会出现一条错位的色带。
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
      <div className="shrink-0 px-8 pt-4 max-md:px-4">
        <nav
          aria-label={tComponents("marketTabs.label")}
          className="flex items-center gap-1 border-b border-border-subtle"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <Link
                key={tab.id}
                to="/agent/mcp"
                search={tab.search}
                // 这两个是**链接**而不是 ARIA tab（它们改变 URL、可分享、可新开标签页），
                // 因此当前项用 `aria-current="page"` 标出，而不是 `role="tab"` + `aria-selected`。
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-brand text-brand"
                    : "border-transparent text-text-secondary hover:text-text-primary"
                }`}
              >
                <Icon size={13} />
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* 内容区各自有 Suspense：切换 tab 时只有内容区进入等待态，tab 栏保持可用。 */}
      <Suspense fallback={<PanelRouteFallback />}>
        {activeTab === "npm" ? <NpmMarketPage /> : <McpMarketPage />}
      </Suspense>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/mcp")({
  component: PluginMarketsPage,
});
