import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fenix/ui-components/ui/dropdown-menu";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import {
  AlertTriangle,
  ExternalLink,
  Globe2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SiteApp } from "../../../api/sites";
import { buildAgentSiteUrl } from "../../../lib/agent-site-url";
import "./agent-sites-catalog.css";

export type SiteVisibilityFilter = "all" | SiteApp["visibility"];

/**
 * 目录页两处状态块（读取失败 / 本页目录为空）共用的排布：`EmptyState` 自带的是 `py-10` 内联块，
 * 这一屏两个位置都要撑满内容区并居中。与 mcp / skills 目录页同款——原 `.site-empty-state` 的
 * `min-height: 380px` 按既有口径取标准刻度 `min-h-96`（384px）。
 *
 * 与库内同名常量**不是逐字重复**，故不改为消费它：`@fenix/ui-components/config/EmptyState` 的
 * `EMPTY_STATE_FILL_CLASS` 是 `min-h-64`（256px），换用它会把这一屏的撑高缩掉 128px、改掉布局意图
 * （`76427173` 下沉该常量时已按同口径登记为「未做」）。
 */
const EMPTY_STATE_FILL_CLASS = "flex min-h-96 flex-col items-center justify-center";

/**
 * 可见性筛选（分段控件）的组内按钮：原 `.site-visibility-filter button` 与
 * `.site-visibility-filter button[aria-pressed="true"]` 两条规则就近取档后的落点，5 个按钮共用。
 * `aria-pressed:` 变体即原属性选择器，选中态（白底 / 蓝字 / 投影 / 加重）覆盖基态灰字、透明底。
 * 取值对照见 `agent-sites-catalog.css` 头部的值映射表（`height: 32px`→`h-8`、`padding: 0 11px`→`py-0 px-2.75`、
 * `font-size: 11px`→`text-xs`、`var(--site-muted)`→`slate-500`、`var(--site-blue)`→`blue-600`、
 * `font-weight: 650`→`font-semibold`、`0 1px 4px rgb(32 48 76 / 8%)`→`shadow-sm`）。
 */
const VISIBILITY_BUTTON_CLASS =
  "h-8 border-0 rounded-md bg-transparent py-0 px-2.75 text-xs text-slate-500 aria-pressed:bg-white aria-pressed:text-blue-600 aria-pressed:shadow-sm aria-pressed:font-semibold";

/**
 * 分页条内两个按钮：原 `.site-pagination button` 的 `height: 28px` / `font-size: 10px`。
 * `Button` 经 `cn()`（tailwind-merge）合并，`h-7` 顶掉 `size="sm"` 的 `h-8`、`text-3xs` 顶掉基态的 `text-sm`。
 */
const PAGINATION_BUTTON_CLASS = "h-7 text-3xs";

type Props = {
  apps: SiteApp[];
  loading: boolean;
  error?: Error;
  query: string;
  visibility: SiteVisibilityFilter;
  page: number;
  totalPages: number;
  onQueryChange: (value: string) => void;
  onVisibilityChange: (value: SiteVisibilityFilter) => void;
  onPageChange: (page: number) => void;
  onCreate: () => void;
  onEdit: (app: SiteApp) => void;
  onDelete: (app: SiteApp) => void;
  onRotateToken: (app: SiteApp) => void;
  onCreatorOpen: (app: SiteApp) => void;
  onRetry: () => void;
};

export function AgentSitesCatalog(props: Props) {
  // `siteDeployment.*` 键随台账 D4 从宿主 `agentPanel` 字典迁入本包 `agents`。
  const { t } = useTranslation(NS.AGENTS);
  if (props.loading) return <SitesLoading />;
  if (props.error && props.apps.length === 0) {
    return (
      <AppPage className="agent-sites-page">
        <EmptyState
          icon={<AlertTriangle />}
          title={t("siteDeployment.errors.load")}
          // 不再回显 `error.message`：那是列表接口错误信封的原文（§9.3）。原始 error 在
          // `AgentSitesPage` 的 `catalog.onError` 里进了 `console.error`，这里只补一句可执行的提示。
          description={t("siteDeployment.errors.loadHint")}
          tone="danger"
          role="alert"
          action={{ label: t("siteDeployment.actions.retry"), onClick: props.onRetry, icon: <RefreshCw /> }}
          className={EMPTY_STATE_FILL_CLASS}
        />
      </AppPage>
    );
  }

  return (
    <AppPage className="agent-sites-page" busy>
      <AppHeader
        title={t("siteDeployment.title")}
        subtitle={t("siteDeployment.subtitle")}
        actions={
          // 尺寸不手写：页头动作区统一走 `Button` 默认档（36px 高 / 16px 内距 / 6px 圆角）。本按钮此前是
          // 另一档（原 `.site-create-button`：40px 高 / 7px 间隙 / 8px 圆角 / 左右各 15px），2026-09-29 收敛掉。
          <Button onClick={props.onCreate}>
            <Plus />
            {t("siteDeployment.actions.create")}
          </Button>
        }
      />
      {/* 工具条的间隙与外边距回到渲染点：刻度在 `@theme` 按 px 落地（`--spacing: 4px`），
          `gap-3` / `mt-3.5` / `mb-5.5` 即 12 / 14 / 22px；类名保留，供 ≤950px 媒体块改轴向。 */}
      <section
        className="site-commandbar flex items-center gap-3 mt-3.5 mb-5.5"
        aria-label={t("siteDeployment.toolbarLabel")}
      >
        <label className="site-search-field relative block">
          {/* 原 `.site-search-field > svg`：绝对定位在 14px 处、16px 宽、`#8d9bb0`（就近落 slate-400）。 */}
          <Search className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-10 w-full rounded border border-slate-200 bg-white py-0 pr-3.5 pl-10.25 text-13 text-slate-800 outline-none focus-visible:ring-3 focus-visible:ring-blue-600/12"
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={t("siteDeployment.search")}
          />
        </label>
        <div
          // 原 `.site-visibility-filter` 的 `display` / `align-items` 与底色 `#e9edf4`（就近落 slate-200）；
          // 类名保留，供 ≤950px 媒体块改溢出行为。
          className="site-visibility-filter flex h-10 items-center gap-0.5 rounded bg-slate-200 p-1"
          role="group"
          aria-label={t("siteDeployment.visibility.label")}
        >
          {(["all", "private", "org", "authenticated", "public"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={VISIBILITY_BUTTON_CLASS}
              aria-pressed={props.visibility === value}
              onClick={() => props.onVisibilityChange(value)}
            >
              {t(`siteDeployment.visibility.${value}`)}
            </button>
          ))}
        </div>
      </section>
      <header className="site-directory-heading min-h-13.5">
        <div>
          {/* 原 `.site-directory-heading h2`（15px / 700）与 `p`（3px 上距 / 10px / `var(--site-faint)`）。 */}
          <h2 className="font-bold text-base">{t("siteDeployment.directory.title")}</h2>
          <p className="mt-0.75 text-3xs text-slate-400">
            {t("siteDeployment.directory.summary", { count: props.apps.length })}
          </p>
        </div>
      </header>
      {props.apps.length === 0 ? (
        <EmptyState
          icon={<Globe2 />}
          title={
            props.query.trim() || props.visibility !== "all"
              ? t("siteDeployment.emptySearch")
              : t("siteDeployment.empty")
          }
          description={t("siteDeployment.emptyHint")}
          // 只有「确实没有站点」才给创建入口：筛选无结果时用户要的是改条件，不是新建。
          action={
            !props.query.trim() && props.visibility === "all"
              ? { label: t("siteDeployment.actions.create"), onClick: props.onCreate }
              : undefined
          }
          className={EMPTY_STATE_FILL_CLASS}
        />
      ) : (
        <section className="grid grid-cols-2 gap-3.5 pt-4 max-lg:grid-cols-1">
          {props.apps.map((app) => (
            <article
              // 边框原为引用 `--site-line` 变量的任意值类（`#e7ecf3`），就近落 slate-200；卡片的投影与卡头三列
              // 仍在 `agent-sites-catalog.css`（复合值）。
              className="site-deployment-card min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white"
              key={app.id}
            >
              <header className="grid items-center gap-3 px-4 pt-4">
                {/* 图标盒原以 `.site-card-icon svg` 定 17px 宽，改挂到图标自身（`size-4.25`）；蓝色原为
                    `var(--site-blue)`（`#2463eb`），就近落 blue-600。 */}
                <span className="grid size-9.5 place-items-center rounded-lg bg-indigo-50 text-blue-600">
                  <Globe2 className="size-4.25" />
                </span>
                <div className="min-w-0">
                  <strong className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs">{app.name}</strong>
                  <small className="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-3xs text-slate-400">
                    {app.remoteAppId}
                  </small>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {/* 原 `.site-more-button svg` 的 16px 与 `Button` 基类
                        `[&_svg:not([class*='size-'])]:size-4` 同值，规则删除后不再另挂类名。 */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7.5 text-slate-500"
                      aria-label={t("siteDeployment.actions.more")}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => props.onRotateToken(app)}>
                      <RefreshCw />
                      {t("siteDeployment.actions.rotateToken")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => props.onEdit(app)}>
                      <Pencil />
                      {t("siteDeployment.actions.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => props.onDelete(app)}>
                      <Trash2 />
                      {t("siteDeployment.actions.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </header>
              <p className="min-h-10 px-4 pt-3 text-3xs text-slate-500 leading-5">
                {app.description || t("siteDeployment.directory.noDescription")}
              </p>
              <footer className="mt-3 flex min-h-11 items-center gap-2.5 border-slate-200 border-t bg-gray-50 px-4 text-3xs text-slate-400">
                <span className="inline-flex items-center gap-1 text-emerald-600">
                  <i className="size-1.5 rounded-full bg-teal-600" />
                  {t("siteDeployment.status.published")}
                </span>
                <span>{t(`siteDeployment.visibility.${app.visibility}`)}</span>
                {app.createdByAgentConfigId && (
                  <button
                    type="button"
                    className="max-w-36 overflow-hidden text-ellipsis whitespace-nowrap text-slate-500 hover:text-blue-600"
                    onClick={() => props.onCreatorOpen(app)}
                  >
                    {app.createdByAgentConfigName || t("siteDeployment.creator")}
                  </button>
                )}
                <a
                  // 原 `.site-open-button svg` 的 12px 宽改挂到图标自身（`size-3`）。
                  className="ml-auto inline-flex items-center gap-1 text-slate-500 hover:text-blue-600"
                  href={buildAgentSiteUrl(app.remoteAppId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("siteDeployment.actions.open")}
                  <ExternalLink className="size-3" />
                </a>
              </footer>
            </article>
          ))}
        </section>
      )}
      {props.totalPages > 1 && (
        <nav
          // 原 `.site-pagination` 的 `display` / `align-items` / `justify-content` 与 `var(--site-muted)`
          // （就近落 slate-500）。
          className="flex items-center justify-center gap-2.25 pt-4 text-3xs text-slate-500"
          aria-label={t("siteDeployment.pagination.label")}
        >
          <Button
            variant="outline"
            size="sm"
            className={PAGINATION_BUTTON_CLASS}
            disabled={props.page <= 1}
            onClick={() => props.onPageChange(props.page - 1)}
          >
            {t("siteDeployment.pagination.previous")}
          </Button>
          <span>
            {props.page} / {props.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className={PAGINATION_BUTTON_CLASS}
            disabled={props.page >= props.totalPages}
            onClick={() => props.onPageChange(props.page + 1)}
          >
            {t("siteDeployment.pagination.next")}
          </Button>
        </nav>
      )}
    </AppPage>
  );
}

function SitesLoading() {
  return (
    <AppPage className="agent-sites-page">
      <Skeleton className="h-7 w-36" />
      <Skeleton className="mt-2 h-4 w-80" />
      <Skeleton className="mt-7 h-10 w-full" />
      <div className="mt-7 grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态装饰、不重排，无领域标识可用作 key，索引键不会引起元素错位；源文件位于 apps/web 时未声明 react 依赖、规则未启用。
          <Skeleton key={index} className="h-64 rounded-lg" />
        ))}
      </div>
    </AppPage>
  );
}
