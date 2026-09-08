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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { SiteApp } from "@/src/api/sites";
import { AppHeader } from "@/src/components/layout/app-header";
import { AppPage } from "@/src/components/layout/app-page";
import { NS } from "@/src/i18n";
import "./agent-sites.css";

export type SiteVisibilityFilter = "all" | SiteApp["visibility"];

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
  const { t } = useTranslation(NS.AGENT_PANEL);
  if (props.loading) return <SitesLoading />;
  if (props.error && props.apps.length === 0) {
    return (
      <AppPage className="agent-sites-page">
        <section className="site-empty-state" role="alert">
          <AlertTriangle />
          <strong>{t("siteDeployment.errors.load")}</strong>
          <p>{props.error.message}</p>
          <Button onClick={props.onRetry}>
            <RefreshCw />
            {t("siteDeployment.actions.retry")}
          </Button>
        </section>
      </AppPage>
    );
  }

  return (
    <AppPage className="agent-sites-page" busy>
      <AppHeader
        title={t("siteDeployment.title")}
        subtitle={t("siteDeployment.subtitle")}
        actions={
          <Button className="site-create-button" onClick={props.onCreate}>
            <Plus />
            {t("siteDeployment.actions.create")}
          </Button>
        }
      />
      <section className="site-commandbar" aria-label={t("siteDeployment.toolbarLabel")}>
        <label className="site-search-field">
          <Search />
          <input
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={t("siteDeployment.search")}
          />
        </label>
        <div className="site-visibility-filter" role="group" aria-label={t("siteDeployment.visibility.label")}>
          {(["all", "private", "org", "authenticated", "public"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={props.visibility === value}
              onClick={() => props.onVisibilityChange(value)}
            >
              {t(`siteDeployment.visibility.${value}`)}
            </button>
          ))}
        </div>
      </section>
      <header className="site-directory-heading">
        <div>
          <h2>{t("siteDeployment.directory.title")}</h2>
          <p>{t("siteDeployment.directory.summary", { count: props.apps.length })}</p>
        </div>
      </header>
      {props.apps.length === 0 ? (
        <section className="site-empty-state">
          <Globe2 />
          <strong>
            {props.query.trim() || props.visibility !== "all"
              ? t("siteDeployment.emptySearch")
              : t("siteDeployment.empty")}
          </strong>
          <p>{t("siteDeployment.emptyHint")}</p>
          {!props.query.trim() && props.visibility === "all" && (
            <Button onClick={props.onCreate}>{t("siteDeployment.actions.create")}</Button>
          )}
        </section>
      ) : (
        <section className="grid grid-cols-2 gap-3.5 pt-4 max-[950px]:grid-cols-1">
          {props.apps.map((app) => (
            <article
              className="min-w-0 overflow-hidden rounded-lg border border-[var(--site-line)] bg-white shadow-[0_5px_18px_rgb(36_57_92/5%)]"
              key={app.id}
            >
              <header className="grid grid-cols-[38px_minmax(0,1fr)_30px] items-center gap-3 px-4 pt-4">
                <span className="grid size-[38px] place-items-center rounded-lg bg-[#edf3ff] text-[var(--site-blue)] [&_svg]:w-[17px]">
                  <Globe2 />
                </span>
                <div className="min-w-0">
                  <strong className="block overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">
                    {app.name}
                  </strong>
                  <small className="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-[var(--site-faint)]">
                    {app.remoteAppId}
                  </small>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-[30px] text-[var(--site-muted)] [&_svg]:w-4"
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
              <p className="min-h-10 px-4 pt-3 text-[11px] text-[var(--site-muted)] leading-5">
                {app.description || t("siteDeployment.directory.noDescription")}
              </p>
              <footer className="mt-3 flex min-h-11 items-center gap-2.5 border-[var(--site-line)] border-t bg-[#fafbfd] px-4 text-[10px] text-[var(--site-faint)]">
                <span className="inline-flex items-center gap-1 text-[#278d70]">
                  <i className="size-1.5 rounded-full bg-[#31a984]" />
                  {t("siteDeployment.status.published")}
                </span>
                <span>{t(`siteDeployment.visibility.${app.visibility}`)}</span>
                {app.createdByAgentConfigId && (
                  <button
                    type="button"
                    className="max-w-36 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--site-muted)] hover:text-[var(--site-blue)]"
                    onClick={() => props.onCreatorOpen(app)}
                  >
                    {app.createdByAgentConfigName || t("siteDeployment.creator")}
                  </button>
                )}
                <a
                  className="ml-auto inline-flex items-center gap-1 text-[var(--site-muted)] hover:text-[var(--site-blue)] [&_svg]:w-3"
                  href={`/web/site/deploy/${encodeURIComponent(app.remoteAppId)}/`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("siteDeployment.actions.open")}
                  <ExternalLink />
                </a>
              </footer>
            </article>
          ))}
        </section>
      )}
      {props.totalPages > 1 && (
        <nav className="site-pagination" aria-label={t("siteDeployment.pagination.label")}>
          <Button
            variant="outline"
            size="sm"
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
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架无领域标识。
          <Skeleton key={index} className="h-64 rounded-[10px]" />
        ))}
      </div>
    </AppPage>
  );
}
