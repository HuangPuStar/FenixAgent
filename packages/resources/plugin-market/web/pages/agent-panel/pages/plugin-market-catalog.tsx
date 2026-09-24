// plugin-market-catalog.tsx — 插件市场目录页的展示骨架（左目录 + 右详情），**只读**
//
// 页面形状与 mcp / skill / 知识库三个目录页一致：`AppPage` → `AppHeader` + `ScopeFilterBar` →
// `AgentMasterDetailWorkspace`。**不新增详情路由**：市场是单页目录，选中项是页内状态，刷新与浏览器历史都
// 不需要第二层路由参与（与三个先例同裁定）。
//
// 两份清单都从调用方传入而不是在这里过滤：`packages` 是后端给的**全量**（范围计数要用全量，否则数字会随
// 关键词跳动），`filtered` 是当前生效的可见集合。目录渲染与选中项解析因此用的是同一份过滤结果——在这里再算
// 一次就多一个「谁说了算」的分歧点（先例：选中了 A、请求的却是 B 的详情）。
//
// 目录过滤与展示取值是纯函数（`web/lib/plugin-market-utils.ts`），本文件只负责渲染；加载与故障两个整页状态
// 也在这里，因为它们互斥且会替换掉整块内容，散在调用方会让调用方同时持有布局与数据两类关注点。
//
// **没有任何写入口**：发布、下架与恢复只在管理台（宿主路由 `/admin/plugin-market`）。因此这里也没有页面级
// 能力位、没有逐行动作、没有已下架范围与下架水印——公开口径的条目与版本历史里根本不含它们（后端
// `toWebPackageView` 只投浏览字段）。

import {
  AgentCatalogIndex,
  AgentCatalogIndexArrow,
  AgentCatalogIndexCopy,
  AgentCatalogIndexIcon,
  AgentCatalogIndexItem,
  AgentCatalogIndexMeta,
  AgentCatalogIndexNav,
} from "@fenix/ui-components/components/agent-catalog-index";
import { AgentMasterDetailWorkspace } from "@fenix/ui-components/components/agent-master-detail-workspace";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { ScopeFilterBar, type ScopeFilterOption } from "@fenix/ui-components/config/ScopeFilterBar";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { AlertTriangle, Package, RefreshCw, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PluginCatalogScope, PluginPackageDetailView, PluginPackageView } from "../../../api/plugin-market-types";
import { PluginMarketDetail, PluginMarketDetailHeader } from "../../../components/plugin-market-detail";
import { PLUGIN_MARKET_NS } from "../../../i18n/namespace";
import {
  countScopes,
  getPackageDisplayName,
  getPackageSummary,
  isUnauthorizedError,
  resolveSelectedPackage,
} from "../../../lib/plugin-market-utils";

type Props = {
  /** 后端返回的**全量**条目（不做服务端分页与检索，过滤在前端完成）；范围计数用它，避免数字随关键词跳动。 */
  packages: PluginPackageView[];
  /** 当前生效的可见集合；目录渲染与选中项解析都用它。 */
  filtered: PluginPackageView[];
  loading: boolean;
  error?: Error | undefined;
  query: string;
  scope: PluginCatalogScope;
  selectedSlug: string | null;
  /** 选中条目的详情；未选中或首帧未返回时为 null。 */
  detail: PluginPackageDetailView | null;
  detailLoading: boolean;
  detailError?: Error | undefined;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: PluginCatalogScope) => void;
  onSelect: (slug: string) => void;
  onRetry: () => void;
  onDetailRetry: () => void;
};

export function PluginMarketCatalog(props: Props) {
  const { t, i18n } = useTranslation(PLUGIN_MARKET_NS);
  if (props.loading) return <MarketCatalogLoading />;
  if (props.error && props.packages.length === 0) {
    // 无权限单独成一个分支：它是稳定结论，**不给重试**（重试不会改变授权结果），
    // 而一般故障保留重试入口，避免把「点一次就好」和「点了也没用」混成同一种界面。
    if (isUnauthorizedError(props.error)) {
      return (
        <AppPage>
          <EmptyState
            icon={<ShieldAlert />}
            title={t("loadState.unauthorizedTitle")}
            description={t("loadState.unauthorizedHint")}
            tone="danger"
            role="alert"
            className="flex min-h-96 flex-col items-center justify-center"
          />
        </AppPage>
      );
    }
    return (
      <AppPage>
        <EmptyState
          icon={<AlertTriangle />}
          title={t("loadState.title")}
          // 说明取本包字典，不回显服务端 `error.message`（§9.3）：信封原文是后端文案、可能带内部实现细节，
          // 且不随界面语言变化。原始对象由容器在 `useRequest` 的 `onError` 里落日志，排障上下文没丢。
          description={t("loadState.hint")}
          tone="danger"
          role="alert"
          className="flex min-h-96 flex-col items-center justify-center"
          action={{ label: t("loadState.retry"), onClick: props.onRetry, icon: <RefreshCw /> }}
        />
      </AppPage>
    );
  }

  const counts = countScopes(props.packages);
  // 有效选中项与调用方用于发详情请求的那次解析是同一个函数、同一份输入（见 `resolveSelectedPackage`）。
  const selected = resolveSelectedPackage(props.filtered, props.selectedSlug);

  // 作用域清单与展示文案归本页所有（组件只负责渲染）：`satisfies` 保留字面量类型，
  // 让下面的回调可以按本页的联合类型收窄，而不是把 `string` 漏进业务状态。
  const scopeOptions = [
    { value: "all", label: t("scope.all"), count: counts.all },
    { value: "teams", label: t("scope.teams"), count: counts.teams },
    { value: "connectors", label: t("scope.connectors"), count: counts.connectors },
  ] satisfies readonly ScopeFilterOption[];

  return (
    <AppPage>
      <AppHeader title={t("title")} subtitle={t("subtitle")} />

      {/* 工具栏的地标名由调用方给出：`role="search"` 与 `aria-label` 都是根节点透传属性。 */}
      <ScopeFilterBar
        role="search"
        aria-label={t("toolbar.label")}
        query={props.query}
        onQueryChange={props.onQueryChange}
        placeholder={t("search")}
        searchLabel={t("search")}
        scopes={scopeOptions}
        scope={props.scope}
        // 组件只透传字符串（它不认识业务作用域），取值来自上面的同一份清单，此处按本页联合类型收窄。
        onScopeChange={(value) => props.onScopeChange(value as PluginCatalogScope)}
        scopeGroupLabel={t("scope.label")}
      />

      {props.filtered.length === 0 ? (
        <EmptyState
          icon={<Package />}
          title={props.packages.length === 0 ? t("empty") : t("emptySearch")}
          description={props.packages.length === 0 ? t("emptyHint") : t("emptySearchHint")}
          className="flex min-h-96 flex-col items-center justify-center"
        />
      ) : (
        <AgentMasterDetailWorkspace
          detailHeader={selected ? <PluginMarketDetailHeader view={selected} /> : null}
          index={
            <AgentCatalogIndex
              title={t("directory.title")}
              count={props.filtered.length}
              description={t("directory.summary", { visible: props.filtered.length, total: props.packages.length })}
            >
              <AgentCatalogIndexNav label={t("directory.title")}>
                {props.filtered.map((view) => {
                  const active = view.slug === selected?.slug;
                  return (
                    <AgentCatalogIndexItem
                      key={view.slug}
                      // `selected` 产出 `aria-current="page"`：既是读屏的「当前页」契约，也是共享 CSS 里
                      // 选中配色与箭头显隐的唯一依据。
                      selected={active}
                      onClick={() => props.onSelect(view.slug)}
                    >
                      <AgentCatalogIndexIcon>
                        <Package />
                      </AgentCatalogIndexIcon>
                      <AgentCatalogIndexCopy
                        title={getPackageDisplayName(view)}
                        subtitle={getPackageSummary(view) ?? t("directory.noDescription")}
                      />
                      {/* 尾注里的每个标签都是一个 `<span>`（共享 CSS 按这个约定给形态）。 */}
                      <AgentCatalogIndexMeta>
                        <span>{view.latestVersion ?? t("directory.noVersion")}</span>
                      </AgentCatalogIndexMeta>
                      <AgentCatalogIndexArrow />
                    </AgentCatalogIndexItem>
                  );
                })}
              </AgentCatalogIndexNav>
            </AgentCatalogIndex>
          }
        >
          <PluginMarketDetail
            detail={props.detail}
            loading={props.detailLoading}
            error={props.detailError}
            // 时刻与体积按当前界面语言本地化：库内格式化原语不读 i18n，语言只在这一处传入。
            locale={i18n.language}
            onRetry={props.onDetailRetry}
          />
        </AgentMasterDetailWorkspace>
      )}
    </AppPage>
  );
}

function MarketCatalogLoading() {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  // 骨架屏本身没有可读内容，屏幕阅读器只会看到一片空白：文案走 sr-only 的 role="status"，
  // 容器再用 `busy` 标出整块仍在加载（与同批目录页、sandbox 面板的状态语义一致）。
  return (
    <AppPage busy>
      <Skeleton className="h-7 w-36" />
      <Skeleton className="mt-2 h-4 w-80" />
      <Skeleton className="mt-7 h-10 w-full" />
      <Skeleton className="mt-7 h-130 w-full rounded-lg" />
      <span className="sr-only" role="status">
        {t("loadState.loading")}
      </span>
    </AppPage>
  );
}
