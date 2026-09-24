// plugin-market-detail.tsx — 市场条目的详情面（展示快照 + 成员清单 + 溯源信息 + 版本历史）
//
// 与列表同页（master-detail），不新增详情路由：市场是单页目录，页内切换选中项，刷新与浏览器历史都不需要
// 第二层路由参与（先例：mcp / skill / 知识库三个目录页）。
//
// **两条面共用这一个渲染件**：同一个条目对谁都是市场里冻结的同一份快照，展示口径不该有两份实现——两份必然
// 漂移成「控制台看得到某一栏、管理台看不到」。差异只有两处，都按**数据是否在手**决定，不靠调用方传开关：
//   1. 行内写动作：管理面经 `versionActions` 注入（下架 / 恢复）；浏览面不传，于是连那一列都不渲染。
//   2. 整包下架水印：只有管理面的投影带 `hidden`（公开面对这类条目返回 404）；浏览面拿到的是 `undefined`。
// 版本历史的「下架时间 + 动作」列与动作槽同进同出：能看到下架水印的那一面，正是能下架的那一面。
//
// 所有渲染字段都来自**市场内冻结的快照**（`metadata`）：页面不读私有源，也没有任何一条路径会把
// `tarballUrl` 变成请求——它只作为溯源文本渲染（`npm-registry/types.ts` 的「永不请求 tarball」）。

import { AgentMasterDetailHeader } from "@fenix/ui-components/components/agent-master-detail-workspace";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PluginPackageMetadata } from "../api/plugin-market-types";
import { PLUGIN_MARKET_NS } from "../i18n/namespace";
import { formatBytes, formatEpochSeconds, getPackageDisplayName, getPackageSummary } from "../lib/plugin-market-utils";

/** 条目成员的三副面孔（agent / skill / server）在展示上是同一个形状，只在取值处映射一次。 */
type MemberItem = { id: string; name: string; hint: string | null };

/**
 * 详情面渲染所需的最小形状。
 *
 * 两条面的详情视图（`PluginPackageDetailView` / `PluginAdminPackageDetailView`）在结构上都满足它，因此这里
 * 不写成两者的联合类型、也不让管理面去 extends 浏览面：两份投影是各自的协议投影，多一个字段（如管理面的
 * `hidden`）不该牵动另一面。
 */
type DetailPackage = {
  packageName: string;
  /** 最新可见版本；整包下架时为 null。 */
  latestVersion: string | null;
  metadata: PluginPackageMetadata | null;
  publishedAt: number | null;
  versions: readonly DetailVersion[];
  /** 整包下架（公开面对该条目返回 404）；只有管理面的投影带这个字段。 */
  hidden?: boolean | undefined;
};

/** 版本行渲染所需的最小形状；下架水印同样只有管理面的投影带。 */
type DetailVersion = {
  exactVersion: string;
  metadataDigest: string;
  firstPublishedAt: number | null;
  publishedAt: number | null;
  isLatest: boolean;
  unpublishedAt?: number | null | undefined;
};

type DetailProps = {
  /** 选中条目的详情；未选中或首帧未返回时为 null。 */
  detail: DetailPackage | null;
  loading: boolean;
  error?: Error | undefined;
  /** 当前界面语言，用于本地化时刻与体积；库内格式化原语不读 i18n。 */
  locale?: string | undefined;
  onRetry: () => void;
  /**
   * 行内写动作槽（管理面注入）：给了它就多出右侧那一列（下架时间 + 下架 / 恢复按钮）。
   *
   * 浏览面没有任何写入口，因此不传——那一列连同表头一起消失，而不是渲染一批永远点不动的按钮。
   */
  versionActions?: ((version: DetailVersion) => ReactNode) | undefined;
};

/** 详情面：加载态 → 故障态（可重试）→ 正文。 */
export function PluginMarketDetail(props: DetailProps) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  // 「还没有详情也没有错误」是选中项刚变化、请求尚未回来的一帧：与加载态同形。把它并进来而不是返回 null，
  // 右侧不会先空一下再出现骨架（详情区的空白容易被读成「这个条目没有内容」）。
  if (props.loading || props.detail === null) {
    if (props.error) {
      return (
        <EmptyState
          icon={<AlertTriangle />}
          title={t("loadState.detailTitle")}
          // 说明取本包字典，不回显服务端 `error.message`（§9.3）：信封原文只由容器在 `useRequest` 的
          // `onError` 里落日志，上屏文案必须随界面语言走。
          description={t("loadState.detailHint")}
          tone="danger"
          role="alert"
          className="flex min-h-80 flex-col items-center justify-center"
          action={{ label: t("loadState.detailRetry"), onClick: props.onRetry, icon: <RefreshCw /> }}
        />
      );
    }
    return <DetailLoading />;
  }
  return <DetailBody {...props} detail={props.detail} />;
}

/** 详情头渲染所需的最小形状（身份 + 展示版本；版本历史与发布时间不在其中）。 */
type DetailHeaderView = {
  packageName: string;
  latestVersion: string | null;
  metadata: PluginPackageMetadata | null;
  /** 整包下架；只有管理面的投影带这个字段。 */
  hidden?: boolean | undefined;
};

/**
 * 详情头：身份（展示名 + 包名）与展示版本。
 *
 * 由两条面的目录骨架共用：详情头在两个位置回答同一件事，各写一份的后果是「管理台的头少一行包名」这类
 * 只靠肉眼能发现的漂移。整包下架徽标同样按数据是否在手决定（浏览面拿不到这类条目）。
 */
export function PluginMarketDetailHeader({ view }: { view: DetailHeaderView }) {
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

function DetailBody({ detail, locale, versionActions }: DetailProps & { detail: DetailPackage }) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  const metadata = detail.metadata;
  const summary = getPackageSummary(detail);
  // 展示版本的摘要：版本历史的第一条就是展示用的那一份（后端 `pickDisplayPublication` 的回退口径）。
  const displayVersion =
    detail.versions.find((version) => version.exactVersion === detail.latestVersion) ?? detail.versions[0] ?? null;

  return (
    <div className="flex flex-col gap-4 p-5">
      {summary ? <p className="text-sm text-text-muted">{summary}</p> : null}

      {detail.hidden ? (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm" role="status">
          {t("detail.hiddenPackage")}
        </p>
      ) : null}

      {metadata?.deprecated ? (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-destructive" role="status">
          {t("detail.deprecated")}
        </p>
      ) : null}

      <Section title={t("detail.overview")}>
        <dl className="flex flex-col gap-2 text-sm">
          <Field label={t("detail.packageName")} value={detail.packageName} />
          <Field
            label={t("detail.latestVersion")}
            value={detail.latestVersion ?? t("directory.noVersion")}
            highlight={detail.latestVersion !== null}
          />
          <Field label={t("detail.publishedAt")} value={formatEpochSeconds(detail.publishedAt, locale)} />
          {displayVersion ? <Field label={t("detail.digest")} value={displayVersion.metadataDigest} mono /> : null}
          {metadata?.description ? <Field label={t("detail.description")} value={metadata.description} /> : null}
        </dl>
        {metadata && metadata.keywords.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {metadata.keywords.map((keyword) => (
              <li key={keyword} className="rounded-sm bg-surface-2 px-2 py-0.5 text-xs text-text-muted">
                {keyword}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title={t("detail.agents")}>
        <MemberList
          empty={t("detail.noAgents")}
          items={(metadata?.agents ?? []).map((agent) => ({ id: agent.id, hint: agent.description, name: agent.name }))}
        />
      </Section>

      <Section title={t("detail.skills")}>
        <MemberList
          empty={t("detail.noSkills")}
          items={(metadata?.skills ?? []).map((skill) => ({
            id: skill.uri,
            hint: skill.description,
            name: skill.name,
          }))}
        />
      </Section>

      <Section title={t("detail.servers")}>
        <MemberList
          empty={t("detail.noServers")}
          items={(metadata?.servers ?? []).map((server) => ({
            hint: [server.transport, server.runtime].filter((part) => part && part.length > 0).join(" · "),
            id: server.id,
            name: server.id,
          }))}
        />
      </Section>

      <Section title={t("detail.provenance")}>
        <dl className="flex flex-col gap-2 text-sm">
          <Field label={t("detail.integrity")} value={metadata?.integrity ?? "—"} mono />
          <Field label={t("detail.tarballUrl")} value={metadata?.tarballUrl ?? "—"} mono />
          <Field
            label={t("detail.unpackedSize")}
            value={formatBytes(metadata?.unpackedSizeBytes ?? null, locale) ?? "—"}
          />
          <Field label={t("detail.fileCount")} value={metadata?.fileCount?.toString() ?? "—"} />
        </dl>
      </Section>

      <Section title={t("detail.versions")} extra={t("detail.versionCount", { count: detail.versions.length })}>
        {detail.versions.length === 0 ? (
          <p className="text-sm text-text-muted">{t("detail.noVersions")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("detail.version")}</TableHead>
                <TableHead>{t("detail.publishedAt")}</TableHead>
                <TableHead>{t("detail.firstPublishedAt")}</TableHead>
                <TableHead>{t("detail.digest")}</TableHead>
                {versionActions ? <TableHead className="text-right">{t("detail.withdrawnAt")}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.versions.map((version) => (
                <TableRow key={version.exactVersion}>
                  <TableCell className="font-medium">
                    {version.exactVersion}
                    {version.isLatest ? (
                      <StatusBadge className="ml-2" status="latest" tone="success" label={t("status.latest")} />
                    ) : null}
                  </TableCell>
                  <TableCell>{formatEpochSeconds(version.publishedAt, locale)}</TableCell>
                  <TableCell>{formatEpochSeconds(version.firstPublishedAt, locale)}</TableCell>
                  <TableCell className="font-mono text-xs">{version.metadataDigest}</TableCell>
                  {versionActions ? <TableCell className="text-right">{versionActions(version)}</TableCell> : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function Section({ title, extra, children }: { title: string; extra?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {extra ? <span className="text-xs text-text-muted">{extra}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * 一行「字段名 + 取值」。
 *
 * 字段名定宽（`w-32`，标准刻度）、取值自适应并可换行：不用方向相反的 `grid-cols` 任意值模板——那类写法
 * 会被 `check:web-style` 的 FCP-WEB-02 拦下，而本页刻意不新增 CSS 文件（样式只用标准刻度与 token）。
 * `<dl>` 下包一层 `<div>` 是合法的定义列表结构（HTML5 允许 `div` 作为 `dl` 的分组子元素）。
 */
function Field({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-text-muted">{label}</dt>
      <dd
        className={`min-w-0 flex-1 break-all ${mono ? "font-mono text-xs" : ""} ${highlight ? "font-medium" : ""}`.trim()}
      >
        {value}
      </dd>
    </div>
  );
}

function MemberList({ items, empty }: { items: readonly MemberItem[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id} className="flex flex-col">
          <span className="text-sm font-medium">{item.name}</span>
          {item.hint ? <span className="text-xs text-text-muted">{item.hint}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function DetailLoading() {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  return (
    // `aria-busy` 只挂在骨架态：恒真会让屏幕阅读器把已加载的页面当成持续更新中的区域。骨架本身没有可访问
    // 文本，因此另给一个 `role="status"` 的读屏提示。
    <div className="flex flex-col gap-4 p-5" aria-busy="true">
      <span className="sr-only" role="status">
        {t("loadState.loading")}
      </span>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
