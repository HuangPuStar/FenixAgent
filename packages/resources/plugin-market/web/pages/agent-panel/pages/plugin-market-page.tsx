// plugin-market-page.tsx — 插件市场目录页的容器（**只读**：数据获取 + 选中态编排）
//
// 与 mcp / skill 目录页同构：容器持有请求状态与选中态，展示骨架（`PluginMarketCatalog`）只收 props。
// 这里承担两件事：
//
// 1. **列表与详情分两次请求**（后端 `/packages` 只给概要视图，详情含版本历史），详情的定位符取自
//    `resolveSelectedPackage` 的解析结果——与左侧高亮用同一个函数，避免「高亮 A、右侧是 B」。
// 2. **不做 `dispatchConfigChange`**：市场条目不是 Agent 的运行时配置，改它不影响任何 agent 进程的启动
//    参数（对比 skill / mcp 的写入会改变 agent 可用的能力清单）。
//
// 页面**没有任何写入口**：发布、下架与恢复是平台管理动作，只在管理台（宿主路由 `/admin/plugin-market`）。
// 用户看得到市场，管理在管理台——这条分界让本页不必知道「当前主体能不能写」，也就不需要写权探测、冲突处理
// 与写后的双刷新（那些都在 `../../admin/AdminPluginMarketPage.tsx`）。

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { pluginMarketApi } from "../../../api/plugin-market";
import type { PluginCatalogScope } from "../../../api/plugin-market-types";
import { PLUGIN_MARKET_NS } from "../../../i18n/namespace";
import { filterPackages, resolveSelectedPackage } from "../../../lib/plugin-market-utils";
import { PluginMarketCatalog } from "./plugin-market-catalog";

export function PluginMarketPage() {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PluginCatalogScope>("all");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const catalog = useRequest(() => unwrap(pluginMarketApi.list()), {
    onError: (error) => {
      console.error(t("toast.loadListFailed"), error);
      // 上屏只给字典文案（§9.3）：`error.message` 是 `unwrap` 抛出的 `ApiError.message`（后端信封原文）
      toast.error(t("toast.loadListFailed"));
    },
  });
  const packages = catalog.data?.packages ?? [];
  // 过滤只算一次：目录渲染、选中项解析与详情请求都用这一份（三处各算一次会让它们对「当前可见集合」产生分歧）。
  const filtered = filterPackages(packages, query, scope);
  const selected = resolveSelectedPackage(filtered, selectedSlug);

  const detail = useRequest((slug: string) => unwrap(pluginMarketApi.get(slug)), {
    manual: true,
    onError: (error) => {
      console.error(t("toast.loadDetailFailed"), error);
    },
  });

  // 选中项变化（含过滤后回退到第一条、列表刷新后同一 slug 仍在）才重新拉详情：依赖只有 slug，
  // 列表刷新导致的对象换新不会触发第二次请求。`run` 的引用稳定由 ahooks 保证（同款写法见
  // `model-management` 的 `AdminModelGatewayPage`）。
  const detailSlug = selected?.slug ?? null;
  useEffect(() => {
    if (detailSlug) void detail.run(detailSlug);
  }, [detailSlug, detail.run]);

  return (
    <PluginMarketCatalog
      packages={packages}
      filtered={filtered}
      loading={catalog.loading}
      error={catalog.error}
      query={query}
      scope={scope}
      selectedSlug={selected?.slug ?? null}
      detail={detail.data?.package ?? null}
      detailLoading={detail.loading}
      detailError={detail.error}
      onQueryChange={setQuery}
      onScopeChange={setScope}
      onSelect={setSelectedSlug}
      onRetry={catalog.refresh}
      onDetailRetry={detail.refresh}
    />
  );
}
