import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Code2,
  Database,
  Eye,
  Globe2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  TerminalSquare,
  Trash2,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { NS } from "../../../i18n";
import { canManageMcpSharing, canWriteMcp, getMcpDisplayName, getMcpKey } from "../../../lib/mcp-resource-access";
import type { McpServerInfo, McpToolInfo } from "../../../types/config";
import { AgentPageHeader } from "../shared/AgentPageHeader";
import {
  countMcpScopes,
  filterMcpServers,
  getMcpCategory,
  type McpCatalogCategory,
  type McpCatalogFilter,
  type McpCatalogScope,
} from "./agent-mcp-utils";
import "./agent-mcp.css";

type Props = {
  servers: McpServerInfo[];
  loading: boolean;
  error?: Error;
  query: string;
  scope: McpCatalogScope;
  filter: McpCatalogFilter;
  category: McpCatalogCategory;
  expandedKey: string | null;
  inspectingKey: string | null;
  sharing: boolean;
  toolsByServer: Record<string, McpToolInfo[]>;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: McpCatalogScope) => void;
  onFilterChange: (value: McpCatalogFilter) => void;
  onCategoryChange: (value: McpCatalogCategory) => void;
  onCreate: () => void;
  onOpen: (server: McpServerInfo) => void;
  onInspect: (server: McpServerInfo) => void;
  onToggleEnabled: (server: McpServerInfo) => void;
  onToggleSharing: (server: McpServerInfo) => void;
  onDelete: (server: McpServerInfo) => void;
  onToggleTools: (server: McpServerInfo) => void;
  onRetry: () => void;
};

export function AgentMcpCatalog(props: Props) {
  const { t } = useTranslation(NS.MCP);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const filtered = filterMcpServers(props.servers, props.query, props.scope, props.filter, props.category);
  const counts = countMcpScopes(props.servers);
  const totalTools = filtered.reduce((total, server) => total + (server.toolsCount ?? 0), 0);

  if (props.loading) return <McpCatalogLoading />;
  if (props.error && props.servers.length === 0) {
    return (
      <main className="agent-mcp-page">
        <section className="mcp-load-error" role="alert">
          <AlertTriangle />
          <strong>{t("loadState.title")}</strong>
          <p>{props.error.message}</p>
          <Button onClick={props.onRetry}>
            <RefreshCw />
            {t("loadState.retry")}
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="agent-mcp-page">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button className="mcp-create-button" onClick={props.onCreate}>
            <Plus />
            {t("btn.newServer")}
          </Button>
        }
      />

      <section className="mcp-commandbar" aria-label={t("toolbar.label")}>
        <label className="mcp-search-field">
          <Search />
          <input
            aria-label={t("search")}
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={props.filter === "installed" ? t("searchInstalled") : t("search")}
          />
        </label>
        <div className="mcp-scope-filter" role="group" aria-label={t("scope.label")}>
          {(
            [
              ["all", t("scope.all"), props.servers.length],
              ["organization", t("scope.organization"), counts.organization],
              ["shared", t("scope.shared"), counts.shared],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={props.scope === value}
              onClick={() => props.onScopeChange(value)}
            >
              {label}
              <small>{count}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="flex items-center justify-end gap-5 pb-2 text-[10px] text-[var(--mcp-muted)]">
        <strong className="text-[13px] text-[var(--mcp-ink)]">
          {t("directory.resultCount", { count: filtered.length })}
        </strong>
        <span className="inline-flex items-center gap-1.5">
          <Wrench className="w-3.5" /> {t("directory.totalTools", { count: totalTools })}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Check className="w-3.5" /> {t("directory.installedCount", { count: counts.organization })}
        </span>
      </div>

      <header className="mcp-directory-heading gap-4">
        <div>
          <h2>{t("directory.title")}</h2>
          <p>{t("directory.summary", { visible: filtered.length, total: props.servers.length })}</p>
        </div>
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1">
          <button
            type="button"
            className={props.filter === "installed" ? "mcp-installed-filter is-active" : "mcp-installed-filter"}
            aria-pressed={props.filter === "installed"}
            onClick={() => props.onFilterChange(props.filter === "installed" ? "all" : "installed")}
          >
            <Check />
            {t("filter.installed")}
            <span>{counts.organization}</span>
          </button>
          <div
            className="flex h-8 items-center gap-0.5 rounded-lg bg-[#e9edf4] p-1"
            role="group"
            aria-label={t("toolbar.label")}
          >
            {(["all", "development", "data", "browser", "cloud"] as const).map((category) => (
              <button
                key={category}
                type="button"
                className={
                  props.category === category
                    ? "h-6 whitespace-nowrap rounded-md bg-white px-2.5 text-[10px] font-semibold text-[var(--mcp-ink)] shadow-sm"
                    : "h-6 whitespace-nowrap rounded-md px-2.5 text-[10px] text-[var(--mcp-muted)] hover:text-[var(--mcp-ink)]"
                }
                aria-pressed={props.category === category}
                onClick={() => props.onCategoryChange(category)}
              >
                {t(`filter.${category}`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {filtered.length === 0 ? (
        <section className="mcp-empty-state">
          <Wrench />
          <strong>{props.servers.length === 0 ? t("empty") : t("emptySearch")}</strong>
          <p>{props.servers.length === 0 ? t("emptyHint") : t("emptySearchHint")}</p>
        </section>
      ) : (
        <section className="grid grid-cols-2 gap-3.5 pt-4 max-[900px]:grid-cols-1">
          {filtered.map((server) => {
            const key = getMcpKey(server);
            const writable = canWriteMcp(server);
            const manageable = canManageMcpSharing(server);
            const external = server.resourceAccess?.ownership === "external";
            const expanded = props.expandedKey === key;
            const tools = props.toolsByServer[key] ?? [];
            const category = getMcpCategory(server);
            const Icon =
              category === "browser"
                ? Globe2
                : category === "data"
                  ? Database
                  : category === "development"
                    ? Code2
                    : server.type === "local"
                      ? TerminalSquare
                      : Cloud;
            return (
              <article
                className="min-w-0 overflow-hidden rounded-lg border border-[var(--mcp-line)] bg-white shadow-[0_6px_22px_rgb(36_57_92/5%)]"
                key={key}
              >
                <header className="grid grid-cols-[42px_minmax(0,1fr)_auto] items-start gap-3 px-4 pt-4">
                  <span
                    className={
                      category === "data"
                        ? "grid size-[42px] place-items-center rounded-lg bg-[#eaf6f2] text-[#238c70] [&_svg]:w-5"
                        : category === "browser"
                          ? "grid size-[42px] place-items-center rounded-lg bg-[#f1edff] text-[#7457d6] [&_svg]:w-5"
                          : "grid size-[42px] place-items-center rounded-lg bg-[#edf3ff] text-[#2463eb] [&_svg]:w-5"
                    }
                  >
                    <Icon />
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <strong className="block overflow-hidden text-ellipsis whitespace-nowrap text-[14px]">
                      {getMcpDisplayName(server)}
                    </strong>
                    <small className="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-[var(--mcp-faint)]">
                      {server.resourceAccess?.sourceOrganizationName ??
                        t(`type.${server.type === "local" ? "local" : "remote"}`)}
                    </small>
                  </div>
                  <span
                    className={
                      server.enabled ? "pt-1 text-[10px] text-[#278d70]" : "pt-1 text-[10px] text-[var(--mcp-faint)]"
                    }
                  >
                    {server.enabled ? `✓ ${t("status.enabled")}` : t("status.disabled")}
                  </span>
                </header>

                <div className="flex items-center gap-1.5 px-4 pt-3">
                  <span
                    className={
                      external
                        ? "inline-flex items-center gap-1 rounded-md bg-[#f1eeff] px-2 py-1 text-[9px] text-[#6e55c7] [&_svg]:w-3"
                        : "inline-flex items-center gap-1 rounded-md bg-[#edf5ff] px-2 py-1 text-[9px] text-[#1e72c8] [&_svg]:w-3"
                    }
                  >
                    {external ? <Share2 /> : <Check />}
                    {external ? t("scope.shared") : t("scope.organization")}
                  </span>
                  <span
                    className={
                      server.enabled
                        ? "inline-flex items-center gap-1 rounded-md bg-[#eaf7f2] px-2 py-1 text-[9px] text-[#278d70]"
                        : "inline-flex items-center gap-1 rounded-md bg-[#f3f5f8] px-2 py-1 text-[9px] text-[var(--mcp-faint)]"
                    }
                  >
                    <CheckCircle2 className="w-3" /> {server.enabled ? t("status.enabled") : t("status.disabled")}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#f3f5f8] px-2 py-1 text-[9px] text-[var(--mcp-muted)]">
                    <Wrench className="w-3" /> {t("directory.toolCount", { count: server.toolsCount ?? 0 })}
                  </span>
                </div>

                <p className="min-h-[58px] px-4 pt-3 text-[11px] text-[var(--mcp-muted)] leading-5">
                  {server.summary || t("directory.noDescription")}
                </p>
                <div className="flex items-center justify-between px-4 pb-3 text-[9px] text-[var(--mcp-faint)]">
                  <span>{t(`filter.${category}`)}</span>
                  <span>{server.type === "local" ? t("type.local") : t("type.remote")}</span>
                </div>

                <footer className="flex min-h-11 items-center border-[var(--mcp-line)] border-t bg-[#fafbfd] px-4 text-[10px] text-[var(--mcp-muted)]">
                  <span>{server.type === "local" ? "stdio" : "HTTP"}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="ml-1 size-7" aria-label={t("actions.more")}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => props.onOpen(server)}>
                        {writable ? <Pencil /> : <Eye />}
                        {writable ? t("btn.edit") : t("btn.view")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => props.onInspect(server)}>
                        <RefreshCw />
                        {t("btn.inspect")}
                      </DropdownMenuItem>
                      {writable ? (
                        <DropdownMenuItem onClick={() => props.onToggleEnabled(server)}>
                          {server.enabled ? t("btn.disable") : t("btn.enable")}
                        </DropdownMenuItem>
                      ) : null}
                      {manageable ? (
                        <DropdownMenuItem disabled={props.sharing} onClick={() => props.onToggleSharing(server)}>
                          {tComponents(
                            server.resourceAccess?.publicReadable ? "resource.makePrivate" : "resource.makePublic",
                          )}
                        </DropdownMenuItem>
                      ) : null}
                      {writable ? (
                        <DropdownMenuItem variant="destructive" onClick={() => props.onDelete(server)}>
                          <Trash2 />
                          {t("btn.delete")}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--mcp-blue)]"
                    onClick={() => (expanded ? props.onToggleTools(server) : props.onOpen(server))}
                  >
                    {expanded ? t("directory.collapse") : t("directory.manage")}
                    <ChevronRight className={expanded ? "w-3 rotate-90" : "w-3"} />
                  </button>
                </footer>

                {expanded && <McpToolList tools={tools} loading={props.inspectingKey === key} />}
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

function McpToolList({ tools, loading }: { tools: McpToolInfo[]; loading: boolean }) {
  const { t } = useTranslation(NS.MCP);
  return (
    <section className="mcp-tool-list" aria-busy={loading}>
      {loading ? (
        <span className="mcp-tools-loading">
          <RefreshCw /> {t("btn.inspecting")}
        </span>
      ) : tools.length === 0 ? (
        <p>{t("tools.noTools")}</p>
      ) : (
        tools.map((tool) => (
          <div key={tool.id}>
            <strong>{tool.toolName}</strong>
            <span>{tool.description || t("directory.noDescription")}</span>
          </div>
        ))
      )}
    </section>
  );
}

function McpCatalogLoading() {
  return (
    <main className="agent-mcp-page" aria-busy="true">
      <Skeleton className="h-7 w-36" />
      <Skeleton className="mt-2 h-4 w-80" />
      <Skeleton className="mt-7 h-10 w-full" />
      <div className="mt-7 grid grid-cols-2 gap-4">
        {Array.from({ length: 6 }).map((_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架没有领域标识。
          <Skeleton key={index} className="h-48 w-full rounded-[10px]" />
        ))}
      </div>
    </main>
  );
}
