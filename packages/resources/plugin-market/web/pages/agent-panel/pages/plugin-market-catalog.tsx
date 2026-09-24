// plugin-market-catalog.tsx — 插件市场目录页的展示骨架（左目录 + 右详情）
//
// 页面形状与 mcp / skill / 知识库三个目录页一致：`AppPage` → `AppHeader` + `ScopeFilterBar` →
// `AgentMasterDetailWorkspace`。**不新增详情路由**：市场是单页目录，选中项是页内状态，刷新与浏览器历史都
// 不需要第二层路由参与（与三个先例同裁定）。
//
// 选中项的**有效值**由调用方解析（`resolveSelectedPackage`）：`selectedSlug` 为 null 或已不在过滤结果里时，
// 回退到第一条。放在调用方而不是本文件，是因为详情要按选中的 slug 发请求——选中态与请求必须取自同一份
// 解析结果，两处各推一次就会漂移（选中了 A、请求的却是 B）。
//
// 目录过滤与计数是纯函数（`plugin-market-utils`），本文件只负责渲染；加载 / 故障 / 无权限三个整页状态也
// 在这里，因为它们互斥且会替换掉整块内容，散在调用方会让调用方同时持有布局与数据两类关注点。

import {
  AgentCatalogIndex,
  AgentCatalogIndexArrow,
  AgentCatalogIndexCopy,
  AgentCatalogIndexIcon,
  AgentCatalogIndexItem,
  AgentCatalogIndexMeta,
  AgentCatalogIndexNav,
} from "@fenix/ui-components/components/agent-catalog-index";
import {
  AgentMasterDetailHeader,
  AgentMasterDetailWorkspace,
} from "@fenix/ui-components/components/agent-master-detail-workspace";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { ScopeFilterBar, type ScopeFilterOption } from "@fenix/ui-components/config/ScopeFilterBar";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { AlertTriangle, Package, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PluginCatalogScope, PluginPackageDetailView, PluginPackageView } from "../../../api/plugin-market-types";
import { PLUGIN_MARKET_NS } from "../../../i18n/namespace";
import { PluginMarketDetail } from "./plugin-market-detail";
import {
  countScopes,
  filterPackages,
  getPackageDisplayName,
  getPackageSummary,
  isUnauthorizedError,
  resolveSelectedPackage,
} from "./plugin-market-utils";

type Props = {
  /** 全量条目（后端不做服务端分页与检索，过滤在本页完成）。 */
  packages: PluginPackageView[];
  loading: boolean;
  error?: Error | undefined;
  query: string;
  scope: PluginCatalogScope;
  /** 页面级能力位：主体是不是平台系统管理员。不按条目推导（空市场时管理员也要有发布入口）。 */
  canPublish: boolean;
  selectedSlug: string | null;
  /** 选中条目的详情；未选中或首帧未返回时为 null。 */
  detail: PluginPackageDetailView | null;
  detailLoading: boolean;
  detailError?: Error | undefined;
  /** 有写操作在飞行中：行内写按钮一起禁用，避免连点出两条命令。 */
  writing: boolean;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: PluginCatalogScope) => void;
  onSelect: (slug: string) => void;
  onPublish: () => void;
  onUnpublish: (packageName: string, exactVersion: string) => void;
  onRestore: (packageName: string, exactVersion: string) => void;
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

  const filtered = filterPackages(props.packages, props.query, props.scope);
  const counts = countScopes(props.packages);
  // 有效选中项与调用方用于发详情请求的那次解析是同一个函数（见 `resolveSelectedPackage` 的说明）。
  const selected = resolveSelectedPackage(props.packages, props.query, props.scope, props.selectedSlug);

  // 作用域清单与展示文案归本页所有（组件只负责渲染）：`satisfies` 保留字面量类型，
  // 让下面的回调可以按本页的联合类型收窄，而不是把 `string` 漏进业务状态。
  const scopeOptions = [
    { value: "all", label: t("scope.all"), count: counts.all },
    { value: "teams", label: t("scope.teams"), count: counts.teams },
    { value: "connectors", label: t("scope.connectors"), count: counts.connectors },
    { value: "withdrawn", label: t("scope.withdrawn"), count: counts.withdrawn },
  ] satisfies readonly ScopeFilterOption[];

  return (
    <AppPage>
      <AppHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          // 发布入口按页面级能力位渲染，而不是按条目：市场为空时没有任何条目可推，管理员仍需入口。
          props.canPublish ? (
            <Button onClick={props.onPublish}>
              <Plus />
              {t("btn.publish")}
            </Button>
          ) : null
        }
      />

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

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Package />}
          title={props.packages.length === 0 ? t("empty") : t("emptySearch")}
          description={props.packages.length === 0 ? t("emptyHint") : t("emptySearchHint")}
          className="flex min-h-96 flex-col items-center justify-center"
        />
      ) : (
        <AgentMasterDetailWorkspace
          detailHeader={selected ? <MarketDetailHeader view={selected} /> : null}
          index={
            <AgentCatalogIndex
              title={t("directory.title")}
              count={filtered.length}
              description={t("directory.summary", { visible: filtered.length, total: props.packages.length })}
            >
              <AgentCatalogIndexNav label={t("directory.title")}>
                {filtered.map((view) => {
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
                        {view.hidden ? <span>{t("status.withdrawn")}</span> : null}
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
            canPublish={props.canPublish}
            writing={props.writing}
            // 时刻与体积按当前界面语言本地化：库内格式化原语不读 i18n，语言只在这一处传入。
            locale={i18n.language}
            onUnpublish={props.onUnpublish}
            onRestore={props.onRestore}
            onRetry={props.onDetailRetry}
          />
        </AgentMasterDetailWorkspace>
      )}
    </AppPage>
  );
}

/** 详情头：身份 + 展示版本 + 下架水印。 */
function MarketDetailHeader({ view }: { view: PluginPackageView }) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  return (
    <AgentMasterDetailHeader className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="truncate text-base font-medium">{getPackageDisplayName(view)}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          <span className="font-mono break-all">{view.packageName}</span>
          <span>
            {t("detail.latestVersion")}：{view.latestVersion ?? t("directory.noVersion")}
          </span>
          {view.hidden ? <StatusBadge status="withdrawn" tone="neutral" label={t("status.withdrawn")} /> : null}
        </div>
      </div>
    </AgentMasterDetailHeader>
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
