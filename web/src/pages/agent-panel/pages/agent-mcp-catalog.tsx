import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Eye,
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
import { Switch } from "@/components/ui/switch";
import { NS } from "../../../i18n";
import { canManageMcpSharing, canWriteMcp, getMcpDisplayName, getMcpKey } from "../../../lib/mcp-resource-access";
import type { McpServerInfo, McpToolInfo } from "../../../types/config";
import { AgentPageHeader } from "../shared/AgentPageHeader";
import { countMcpScopes, filterMcpServers, type McpCatalogFilter, type McpCatalogScope } from "./agent-mcp-utils";
import "./agent-mcp.css";

type Props = {
  servers: McpServerInfo[];
  loading: boolean;
  error?: Error;
  query: string;
  scope: McpCatalogScope;
  filter: McpCatalogFilter;
  expandedKey: string | null;
  inspectingKey: string | null;
  sharing: boolean;
  toolsByServer: Record<string, McpToolInfo[]>;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: McpCatalogScope) => void;
  onFilterChange: (value: McpCatalogFilter) => void;
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
  const filtered = filterMcpServers(props.servers, props.query, props.scope, props.filter);
  const counts = countMcpScopes(props.servers);

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

      <header className="mcp-directory-heading">
        <div>
          <h2>{t("directory.title")}</h2>
          <p>{t("directory.summary", { visible: filtered.length, total: props.servers.length })}</p>
        </div>
        <button
          type="button"
          className={props.filter === "installed" ? "mcp-installed-filter is-active" : "mcp-installed-filter"}
          aria-pressed={props.filter === "installed"}
          onClick={() => props.onFilterChange(props.filter === "installed" ? "all" : "installed")}
        >
          <Check />
          {t("filter.installed")}
          <span>{counts.organization}</span>
          <ChevronDown />
        </button>
      </header>

      {filtered.length === 0 ? (
        <section className="mcp-empty-state">
          <Wrench />
          <strong>{props.servers.length === 0 ? t("empty") : t("emptySearch")}</strong>
          <p>{props.servers.length === 0 ? t("emptyHint") : t("emptySearchHint")}</p>
        </section>
      ) : (
        <section className="mcp-plugin-grid">
          {filtered.map((server) => {
            const key = getMcpKey(server);
            const writable = canWriteMcp(server);
            const manageable = canManageMcpSharing(server);
            const external = server.resourceAccess?.ownership === "external";
            const expanded = props.expandedKey === key;
            const tools = props.toolsByServer[key] ?? [];
            const Icon = server.type === "local" ? TerminalSquare : Cloud;
            return (
              <article className="mcp-plugin-item" key={key}>
                <header>
                  <span className={server.type === "local" ? "mcp-plugin-icon is-local" : "mcp-plugin-icon"}>
                    <Icon />
                  </span>
                  <div>
                    <strong>{getMcpDisplayName(server)}</strong>
                    <small>{server.summary || t("directory.noDescription")}</small>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="mcp-more-button" aria-label={t("actions.more")}>
                        <MoreHorizontal />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => props.onOpen(server)}>
                        {writable ? <Pencil /> : <Eye />}
                        {writable ? t("btn.edit") : t("btn.view")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => props.onInspect(server)}>
                        <RefreshCw />
                        {t("btn.inspect")}
                      </DropdownMenuItem>
                      {writable && (
                        <DropdownMenuItem variant="destructive" onClick={() => props.onDelete(server)}>
                          <Trash2 />
                          {t("btn.delete")}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </header>

                <div className="mcp-plugin-meta">
                  <span className={external ? "is-shared" : "is-organization"}>
                    {external ? <Share2 /> : <Check />}
                    {external ? t("scope.shared") : t("scope.organization")}
                  </span>
                  <span>
                    <Wrench /> {t("directory.toolCount", { count: server.toolsCount ?? 0 })}
                  </span>
                  <span>{server.type === "local" ? t("type.local") : t("type.remote")}</span>
                </div>

                <footer>
                  <div>
                    <span className={server.enabled ? "mcp-status-dot is-enabled" : "mcp-status-dot"} />
                    {server.enabled ? t("status.enabled") : t("status.disabled")}
                  </div>
                  {manageable && (
                    <label>
                      <Switch
                        aria-label={tComponents("resource.public")}
                        checked={Boolean(server.resourceAccess?.publicReadable)}
                        disabled={props.sharing}
                        onCheckedChange={() => props.onToggleSharing(server)}
                      />
                      {tComponents("resource.public")}
                    </label>
                  )}
                  {writable && (
                    <button type="button" onClick={() => props.onToggleEnabled(server)}>
                      {server.enabled ? t("btn.disable") : t("btn.enable")}
                    </button>
                  )}
                  <button type="button" onClick={() => props.onToggleTools(server)}>
                    {expanded ? t("directory.collapse") : t("directory.details")}
                    <ChevronRight className={expanded ? "is-expanded" : ""} />
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
