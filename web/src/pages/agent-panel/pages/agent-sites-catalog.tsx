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
import { NS } from "@/src/i18n";
import { AgentPageHeader } from "../shared/AgentPageHeader";
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
  onOpen: (app: SiteApp) => void;
  onCreatorOpen: (app: SiteApp) => void;
  onRetry: () => void;
};

export function AgentSitesCatalog(props: Props) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  if (props.loading) return <SitesLoading />;
  if (props.error && props.apps.length === 0) {
    return (
      <main className="agent-sites-page">
        <section className="site-empty-state" role="alert">
          <AlertTriangle />
          <strong>{t("siteDeployment.errors.load")}</strong>
          <p>{props.error.message}</p>
          <Button onClick={props.onRetry}>
            <RefreshCw />
            {t("siteDeployment.actions.retry")}
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="agent-sites-page">
      <AgentPageHeader
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
        <section className="site-card-grid">
          {props.apps.map((app, index) => (
            <article className="site-deployment-card" key={app.id}>
              <button
                type="button"
                className={`site-deployment-preview is-variant-${(index % 4) + 1}`}
                onClick={() => props.onOpen(app)}
              >
                <span>{app.name.slice(0, 2).toUpperCase()}</span>
                <i />
                <i />
                <i />
              </button>
              <div className="site-card-body">
                <header>
                  <span className="site-card-icon">
                    <Globe2 />
                  </span>
                  <div>
                    <strong>{app.name}</strong>
                    <small>{app.remoteAppId}</small>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="site-more-button" aria-label={t("siteDeployment.actions.more")}>
                        <MoreHorizontal />
                      </button>
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
                <p>{app.description || t("siteDeployment.directory.noDescription")}</p>
                <footer>
                  <span className="site-published-status">
                    <i />
                    {t("siteDeployment.status.published")}
                  </span>
                  <span>{t(`siteDeployment.visibility.${app.visibility}`)}</span>
                  {app.createdByAgentConfigId && (
                    <button type="button" onClick={() => props.onCreatorOpen(app)}>
                      {app.createdByAgentConfigName || t("siteDeployment.creator")}
                    </button>
                  )}
                  <button type="button" className="site-open-button" onClick={() => props.onOpen(app)}>
                    {t("siteDeployment.actions.open")}
                    <ExternalLink />
                  </button>
                </footer>
              </div>
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
    </main>
  );
}

function SitesLoading() {
  return (
    <main className="agent-sites-page" aria-busy="true">
      <Skeleton className="h-7 w-36" />
      <Skeleton className="mt-2 h-4 w-80" />
      <Skeleton className="mt-7 h-10 w-full" />
      <div className="mt-7 grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架无领域标识。
          <Skeleton key={index} className="h-64 rounded-[10px]" />
        ))}
      </div>
    </main>
  );
}
