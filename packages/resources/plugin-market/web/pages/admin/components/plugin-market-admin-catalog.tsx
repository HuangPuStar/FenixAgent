// plugin-market-admin-catalog.tsx — 管理台的插件目录骨架（左目录 + 右详情），**写入口在这一面**
//
// 与浏览面骨架（`plugin-market-catalog`）是两份而不是一份带开关的：两条面的**数据形状**不同（管理面多
// `hidden` 与逐版本的 `unpublishedAt`）、**外壳**不同（这里在 `/admin` 布局内，不套控制台的 `AppPage`）、
// **可做的事**不同（这里能下架 / 恢复）。把三处差异塞进一个组件，只会让浏览面拿到一批它永远不会用的 props。
// 共用的部分仍然共用：详情正文与详情头（`web/components/plugin-market-detail`）、范围判定与展示取值
// （`web/lib/plugin-market-utils`）。
//
// 目录过滤与选中项解析与浏览面同构：两份清单由调用方传入（`packages` 是全量、`filtered` 是当前生效集合），
// 目录渲染与选中项解析用同一份过滤结果——在这里再算一次就多一个「谁说了算」的分歧点。
//
// 这一面**没有逐行能力位**：管理面的请求里没有主体（判据是系统 master key），能进这一页就能写。

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
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { AlertTriangle, Package, RefreshCw, RotateCcw, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PluginAdminPackageDetailView, PluginAdminPackageView } from "../../../api/system-plugin-market-types";
import { PluginMarketDetail, PluginMarketDetailHeader } from "../../../components/plugin-market-detail";
import { PLUGIN_MARKET_NS } from "../../../i18n/namespace";
import { countAdminScopes, type PluginAdminCatalogScope } from "../../../lib/plugin-market-admin-utils";
import {
  formatEpochSeconds,
  getPackageDisplayName,
  getPackageSummary,
  resolveSelectedPackage,
} from "../../../lib/plugin-market-utils";

type Props = {
  /** 全量条目（含整包下架的）；范围计数用它，避免数字随关键词跳动。 */
  packages: PluginAdminPackageView[];
  /** 当前生效的可见集合；目录渲染与选中项解析都用它。 */
  filtered: PluginAdminPackageView[];
  loading: boolean;
  error?: Error | undefined;
  query: string;
  scope: PluginAdminCatalogScope;
  selectedSlug: string | null;
  /** 选中条目的详情；未选中或首帧未返回时为 null。 */
  detail: PluginAdminPackageDetailView | null;
  detailLoading: boolean;
  detailError?: Error | undefined;
  /** 有写请求在飞：动作按钮禁用（写入会改变版本可见性，重复点击是两次状态迁移）。 */
  writing: boolean;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: PluginAdminCatalogScope) => void;
  onSelect: (slug: string) => void;
  onRetry: () => void;
  onDetailRetry: () => void;
  /** 下架某个精确版本；`packageName` 由渲染中的详情给出，与按钮所在的那张版本表同源。 */
  onUnpublish: (packageName: string, exactVersion: string) => void;
  /** 恢复某个已下架版本。 */
  onRestore: (packageName: string, exactVersion: string) => void;
};

export function PluginMarketAdminCatalog(props: Props) {
  const { t, i18n } = useTranslation(PLUGIN_MARKET_NS);
  if (props.loading) return <CatalogLoading />;
  if (props.error && props.packages.length === 0) {
    // 这里没有「无权限」分支：管理面的 401 由容器清掉 master key 并把人送回门，页面不该留在原地显示
    // 「无权访问」——那会让人以为换个账号就能看，而真正要做的只是重新输入 key。
    return (
      <EmptyState
        icon={<AlertTriangle />}
        title={t("loadState.title")}
        description={t("loadState.hint")}
        tone="danger"
        role="alert"
        className="flex min-h-96 flex-col items-center justify-center"
        action={{ label: t("loadState.retry"), onClick: props.onRetry, icon: <RefreshCw /> }}
      />
    );
  }

  const counts = countAdminScopes(props.packages);
  const selected = resolveSelectedPackage(props.filtered, props.selectedSlug);

  // 四档范围与文案归本页所有（组件只负责渲染）：`satisfies` 保留字面量类型，回调可以按本页联合类型收窄。
  const scopeOptions = [
    { value: "all", label: t("scope.all"), count: counts.all },
    { value: "teams", label: t("scope.teams"), count: counts.teams },
    { value: "connectors", label: t("scope.connectors"), count: counts.connectors },
    { value: "withdrawn", label: t("scope.withdrawn"), count: counts.withdrawn },
  ] satisfies readonly ScopeFilterOption[];

  return (
    <div className="flex flex-col gap-4">
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
        onScopeChange={(value) => props.onScopeChange(value as PluginAdminCatalogScope)}
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
                    <AgentCatalogIndexItem key={view.slug} selected={active} onClick={() => props.onSelect(view.slug)}>
                      <AgentCatalogIndexIcon>
                        <Package />
                      </AgentCatalogIndexIcon>
                      <AgentCatalogIndexCopy
                        title={getPackageDisplayName(view)}
                        subtitle={getPackageSummary(view) ?? t("directory.noDescription")}
                      />
                      <AgentCatalogIndexMeta>
                        {/* 整包下架的条目没有可见版本可显示：尾注给水印，让「为什么这一条没有版本号」有答案。 */}
                        {view.hidden ? (
                          <StatusBadge status="withdrawn" tone="neutral" label={t("status.withdrawn")} />
                        ) : (
                          <span>{view.latestVersion ?? t("directory.noVersion")}</span>
                        )}
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
            // 写入口只在这一面注入：浏览面不传这个槽，版本历史就没有那一列。
            versionActions={(version) =>
              props.detail ? (
                <VersionActions
                  version={version}
                  packageName={props.detail.packageName}
                  writing={props.writing}
                  onUnpublish={props.onUnpublish}
                  onRestore={props.onRestore}
                />
              ) : null
            }
          />
        </AgentMasterDetailWorkspace>
      )}
    </div>
  );
}

/**
 * 行内写动作：可见版本给「下架」，已下架版本带下架时间水印并给「恢复」。
 *
 * 不做能力位判断（浏览面 `canWritePackage` 那一套）：管理面的判据是系统凭据，能进这一页就能写。
 */
function VersionActions({
  version,
  packageName,
  writing,
  onUnpublish,
  onRestore,
}: {
  version: { exactVersion: string; unpublishedAt?: number | null | undefined };
  packageName: string;
  writing: boolean;
  onUnpublish: (packageName: string, exactVersion: string) => void;
  onRestore: (packageName: string, exactVersion: string) => void;
}) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);

  if (version.unpublishedAt !== null && version.unpublishedAt !== undefined) {
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-text-muted">{formatEpochSeconds(version.unpublishedAt)}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={writing}
          onClick={() => onRestore(packageName, version.exactVersion)}
        >
          <RotateCcw />
          {t("btn.restore")}
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={writing}
      onClick={() => onUnpublish(packageName, version.exactVersion)}
    >
      <Undo2 />
      {t("btn.unpublish")}
    </Button>
  );
}

function CatalogLoading() {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-130 w-full rounded-lg" />
      <span className="sr-only" role="status">
        {t("loadState.loading")}
      </span>
    </div>
  );
}
