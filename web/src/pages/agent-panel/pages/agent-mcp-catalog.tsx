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
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  TerminalSquare,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AppHeader } from "@/src/components/layout/app-header";
import { AppPage } from "@/src/components/layout/app-page";
import { NS } from "../../../i18n";
import { canManageMcpSharing, canWriteMcp, getMcpDisplayName, getMcpKey } from "../../../lib/mcp-resource-access";
import type { McpServerInfo, McpToolInfo } from "../../../types/config";
import { AgentMasterDetailHeader, AgentMasterDetailWorkspace } from "../shared/agent-master-detail-workspace";
import {
  countMcpScopes,
  filterMcpServers,
  getMcpCategory,
  type McpCatalogCategory,
  type McpCatalogFilter,
  type McpCatalogScope,
} from "./agent-mcp-utils";
import "./agent-mcp.css";
import "./agent-mcp-detail.css";

type Props = {
  servers: McpServerInfo[];
  loading: boolean;
  error?: Error;
  query: string;
  scope: McpCatalogScope;
  filter: McpCatalogFilter;
  category: McpCatalogCategory;
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
  onRetry: () => void;
};

function getMcpIcon(server: McpServerInfo) {
  const category = getMcpCategory(server);
  if (category === "browser") return Globe2;
  if (category === "data") return Database;
  if (category === "development") return Code2;
  return server.type === "local" ? TerminalSquare : Cloud;
}

export function AgentMcpCatalog(props: Props) {
  const { t } = useTranslation(NS.MCP);
  const filtered = filterMcpServers(props.servers, props.query, props.scope, props.filter, props.category);
  const counts = countMcpScopes(props.servers);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedServer = filtered.find((server) => getMcpKey(server) === selectedKey) ?? filtered[0] ?? null;

  useEffect(() => {
    if (selectedServer && selectedKey !== getMcpKey(selectedServer)) setSelectedKey(getMcpKey(selectedServer));
  }, [selectedKey, selectedServer]);

  if (props.loading) return <McpCatalogLoading />;
  if (props.error && props.servers.length === 0) {
    return (
      <AppPage className="agent-mcp-page">
        <section className="mcp-load-error" role="alert">
          <AlertTriangle />
          <strong>{t("loadState.title")}</strong>
          <p>{props.error.message}</p>
          <Button onClick={props.onRetry}>
            <RefreshCw />
            {t("loadState.retry")}
          </Button>
        </section>
      </AppPage>
    );
  }

  return (
    <AppPage className="agent-mcp-page" busy>
      <AppHeader
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

      <section className="mcp-secondary-filters" aria-label={t("toolbar.label")}>
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
        <div className="mcp-category-filter" role="group" aria-label={t("toolbar.label")}>
          {(["all", "development", "data", "browser", "cloud"] as const).map((category) => (
            <button
              key={category}
              type="button"
              aria-pressed={props.category === category}
              onClick={() => props.onCategoryChange(category)}
            >
              {t(`filter.${category}`)}
            </button>
          ))}
        </div>
      </section>

      {filtered.length === 0 ? (
        <section className="mcp-empty-state">
          <Wrench />
          <strong>{props.servers.length === 0 ? t("empty") : t("emptySearch")}</strong>
          <p>{props.servers.length === 0 ? t("emptyHint") : t("emptySearchHint")}</p>
        </section>
      ) : (
        <AgentMasterDetailWorkspace
          className="mcp-master-detail"
          detailHeader={selectedServer ? <McpDetailHeader server={selectedServer} props={props} /> : null}
          detailFooter={selectedServer ? <McpDetailActions server={selectedServer} props={props} /> : null}
          index={
            <aside className="mcp-directory">
              <header>
                <div>
                  <strong>{t("directory.title")}</strong>
                  <span>{filtered.length}</span>
                </div>
                <small>
                  {t("directory.summary", {
                    visible: filtered.length,
                    total: props.servers.length,
                  })}
                </small>
              </header>
              <nav aria-label={t("directory.title")}>
                {filtered.map((server) => {
                  const key = getMcpKey(server);
                  const active = key === getMcpKey(selectedServer);
                  const external = server.resourceAccess?.ownership === "external";
                  const publiclyReadable = external || server.resourceAccess?.publicReadable === true;
                  const Icon = getMcpIcon(server);
                  return (
                    <button
                      type="button"
                      key={key}
                      aria-current={active ? "page" : undefined}
                      className={active ? "is-selected" : ""}
                      onClick={() => setSelectedKey(key)}
                    >
                      <span className="mcp-directory-icon">{external ? <Share2 /> : <Icon />}</span>
                      <span className="mcp-directory-copy">
                        <strong>{getMcpDisplayName(server)}</strong>
                        <small>{server.summary || t("directory.noDescription")}</small>
                      </span>
                      <span className="mcp-directory-meta">
                        <span title={server.resourceAccess?.sourceOrganizationName}>
                          {server.resourceAccess?.sourceOrganizationName ??
                            t(`type.${server.type === "local" ? "local" : "remote"}`)}
                        </span>
                        {publiclyReadable ? <b>{t("scope.shared")}</b> : null}
                      </span>
                      <ChevronRight />
                    </button>
                  );
                })}
              </nav>
            </aside>
          }
        >
          {selectedServer ? <McpDetailBody server={selectedServer} props={props} /> : null}
        </AgentMasterDetailWorkspace>
      )}
    </AppPage>
  );
}

function McpDetailHeader({ server, props }: { server: McpServerInfo; props: Props }) {
  const { t } = useTranslation(NS.MCP);
  const writable = canWriteMcp(server);
  const external = server.resourceAccess?.ownership === "external";
  const publiclyReadable = external || server.resourceAccess?.publicReadable === true;
  const Icon = getMcpIcon(server);
  return (
    <AgentMasterDetailHeader className="mcp-detail-header">
      <div className="mcp-detail-identity">
        <span className="mcp-detail-icon">{external ? <Share2 /> : <Icon />}</span>
        <div>
          <h2>{getMcpDisplayName(server)}</h2>
          <div className="mcp-detail-meta">
            <span>{server.resourceAccess?.sourceOrganizationName ?? t("scope.organization")}</span>
            {publiclyReadable ? <b>{t("scope.shared")}</b> : null}
          </div>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => props.onOpen(server)}>
        {writable ? <Pencil /> : <Eye />}
        {writable ? t("btn.edit") : t("btn.view")}
      </Button>
    </AgentMasterDetailHeader>
  );
}

function McpDetailBody({ server, props }: { server: McpServerInfo; props: Props }) {
  const { t } = useTranslation(NS.MCP);
  const key = getMcpKey(server);
  const tools = props.toolsByServer[key] ?? [];
  const loading = props.inspectingKey === key;
  return (
    <article className="mcp-detail-body">
      <section className="mcp-detail-summary">
        <span>MCP</span>
        <p>{server.summary || t("directory.noDescription")}</p>
      </section>
      <dl className="mcp-detail-facts">
        <div>
          <dt>{t("column.type")}</dt>
          <dd>{t(`type.${server.type === "local" ? "local" : "remote"}`)}</dd>
        </div>
        <div>
          <dt>{t("column.status")}</dt>
          <dd className={server.enabled ? "is-enabled" : ""}>
            {server.enabled ? t("status.enabled") : t("status.disabled")}
          </dd>
        </div>
        <div>
          <dt>{t("column.tools")}</dt>
          <dd>
            {t("directory.toolCount", {
              count: server.toolsCount ?? tools.length,
            })}
          </dd>
        </div>
        <div>
          <dt>{t("directory.details")}</dt>
          <dd>{server.type === "local" ? "stdio" : "HTTP"}</dd>
        </div>
      </dl>
      <section className="mcp-detail-tools">
        <header>
          <div>
            <h3>{t("column.tools")}</h3>
            <p>{t("directory.toolCount", { count: tools.length })}</p>
          </div>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => props.onInspect(server)}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
            {loading ? t("btn.inspecting") : t("btn.inspect")}
          </Button>
        </header>
        <McpToolList tools={tools} loading={loading} />
      </section>
    </article>
  );
}

function McpDetailActions({ server, props }: { server: McpServerInfo; props: Props }) {
  const { t } = useTranslation(NS.MCP);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const writable = canWriteMcp(server);
  const manageable = canManageMcpSharing(server);
  return (
    <div className="mcp-detail-actions">
      <Button variant="outline" size="sm" onClick={() => props.onInspect(server)}>
        <RefreshCw /> {t("btn.inspect")}
      </Button>
      {writable ? (
        <Button variant="ghost" size="sm" onClick={() => props.onToggleEnabled(server)}>
          <CheckCircle2 /> {server.enabled ? t("btn.disable") : t("btn.enable")}
        </Button>
      ) : null}
      {manageable ? (
        <Button variant="ghost" size="sm" disabled={props.sharing} onClick={() => props.onToggleSharing(server)}>
          <Share2 />
          {tComponents(server.resourceAccess?.publicReadable ? "resource.makePrivate" : "resource.makePublic")}
        </Button>
      ) : null}
      {writable ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => props.onDelete(server)}
        >
          <Trash2 /> {t("btn.delete")}
        </Button>
      ) : null}
    </div>
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
    <AppPage className="agent-mcp-page">
      <Skeleton className="h-7 w-36" />
      <Skeleton className="mt-2 h-4 w-80" />
      <Skeleton className="mt-7 h-10 w-full" />
      <Skeleton className="mt-7 h-[520px] w-full rounded-[10px]" />
    </AppPage>
  );
}
