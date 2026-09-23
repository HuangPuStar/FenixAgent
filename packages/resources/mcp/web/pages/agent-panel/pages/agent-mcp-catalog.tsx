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
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import type { McpServerInfo, McpToolInfo } from "@fenix/web-runtime/types/config";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  ShieldAlert,
  TerminalSquare,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canManageMcpSharing,
  canWriteMcp,
  getMcpDisplayName,
  getMcpKey,
  isExternalMcp,
} from "../../../lib/mcp-resource-access";
import { countMcpScopes, filterMcpServers, isUnauthorizedError, type McpCatalogScope } from "./agent-mcp-utils";
import "./agent-mcp.css";
import "./agent-mcp-detail.css";

type Props = {
  servers: McpServerInfo[];
  loading: boolean;
  error?: Error;
  query: string;
  scope: McpCatalogScope;
  /** 当前组织 id，用于比对 `scope.organizationId` 判定资源是否来自其他组织。 */
  activeOrganizationId?: string;
  inspectingKey: string | null;
  sharing: boolean;
  toolsByServer: Record<string, McpToolInfo[]>;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: McpCatalogScope) => void;
  onCreate: () => void;
  onOpen: (server: McpServerInfo) => void;
  onInspect: (server: McpServerInfo) => void;
  onToggleEnabled: (server: McpServerInfo) => void;
  onToggleSharing: (server: McpServerInfo) => void;
  onDelete: (server: McpServerInfo) => void;
  onRetry: () => void;
};

function getMcpIcon(server: McpServerInfo) {
  return server.type === "local" ? TerminalSquare : Cloud;
}

export function AgentMcpCatalog(props: Props) {
  const { t } = useTranslation(NS.MCP);
  const filtered = filterMcpServers(props.servers, props.query, props.scope, props.activeOrganizationId);
  const counts = countMcpScopes(props.servers, props.activeOrganizationId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedServer = filtered.find((server) => getMcpKey(server) === selectedKey) ?? filtered[0] ?? null;

  useEffect(() => {
    if (selectedServer && selectedKey !== getMcpKey(selectedServer)) setSelectedKey(getMcpKey(selectedServer));
  }, [selectedKey, selectedServer]);

  if (props.loading) return <McpCatalogLoading />;
  if (props.error && props.servers.length === 0) {
    // 无权限单独成一个分支：它不给重试按钮（原因见 `isUnauthorizedError`），
    // 而一般故障仍然保留重试入口，避免把「点一次就好」和「点了也没用」混成同一种界面。
    if (isUnauthorizedError(props.error)) {
      return (
        <AppPage className="agent-mcp-page">
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
      <AppPage className="agent-mcp-page">
        <EmptyState
          icon={<AlertTriangle />}
          title={t("loadState.title")}
          description={props.error.message}
          tone="danger"
          role="alert"
          className="flex min-h-96 flex-col items-center justify-center"
          action={{ label: t("loadState.retry"), onClick: props.onRetry, icon: <RefreshCw /> }}
        />
      </AppPage>
    );
  }

  // 作用域清单与展示文案归本页所有（组件只负责渲染）：`satisfies` 保留字面量类型，
  // 让下面的回调可以按本页的联合类型收窄，而不是把 `string` 漏进业务状态。
  const scopeOptions = [
    { value: "all", label: t("scope.all"), count: props.servers.length },
    { value: "organization", label: t("scope.organization"), count: counts.organization },
    { value: "public", label: t("scope.public"), count: counts.public },
  ] satisfies readonly ScopeFilterOption[];

  // 这里已不是加载态（loading 在上方提前返回），因此不标 aria-busy：恒真的 busy 会让屏幕阅读器
  // 把整页更新一直当作「未完成」而推迟播报。加载态的 aria-busy 由 McpCatalogLoading 承担。
  return (
    <AppPage className="agent-mcp-page">
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

      {/* 工具栏的地标名由调用方给出：`role="search"` 与 `aria-label` 都是根节点透传属性，
          原来承载这层语义的 `<section aria-label>` 已随重复实现一起收敛进组件。 */}
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
        onScopeChange={(value) => props.onScopeChange(value as McpCatalogScope)}
        scopeGroupLabel={t("scope.label")}
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Wrench />}
          title={props.servers.length === 0 ? t("empty") : t("emptySearch")}
          description={props.servers.length === 0 ? t("emptyHint") : t("emptySearchHint")}
          className="flex min-h-96 flex-col items-center justify-center"
        />
      ) : (
        <AgentMasterDetailWorkspace
          className="mcp-master-detail"
          detailHeader={selectedServer ? <McpDetailHeader server={selectedServer} props={props} /> : null}
          detailFooter={selectedServer ? <McpDetailActions server={selectedServer} props={props} /> : null}
          index={
            // 目录头部（标题 + 计数徽标 + 说明行）、条目四列网格与截断/箭头显隐已收敛到
            // `AgentCatalogIndex` 一族：本页头部原与模型库那份逐字相同，四列模板与技能库、
            // 模型库逐字相同。`mcp-directory` 类名保留，`agent-mcp.css` 里只剩本页刻度：
            // 19/10 内边距、57px 行高、3px 行间距、px 字号与选中配色。
            <AgentCatalogIndex
              className="mcp-directory"
              title={t("directory.title")}
              count={filtered.length}
              description={t("directory.summary", { visible: filtered.length, total: props.servers.length })}
            >
              <AgentCatalogIndexNav label={t("directory.title")}>
                {filtered.map((server) => {
                  const key = getMcpKey(server);
                  const active = key === getMcpKey(selectedServer);
                  const external = isExternalMcp(server, props.activeOrganizationId);
                  const publiclyReadable = server.scope?.visibility === "public";
                  const Icon = getMcpIcon(server);
                  return (
                    <AgentCatalogIndexItem
                      key={key}
                      // `selected` 产出 `aria-current="page"`（读屏的「当前页」契约，也是箭头显隐的依据）；
                      // `is-selected` 只是本页选中配色的钩子，规则留在 `agent-mcp.css` 的类选择器里。
                      selected={active}
                      className={active ? "is-selected" : ""}
                      onClick={() => setSelectedKey(key)}
                    >
                      <AgentCatalogIndexIcon className="mcp-directory-icon">
                        {external ? <Share2 /> : <Icon />}
                      </AgentCatalogIndexIcon>
                      {/* 保留本页类名：`.mcp-directory-copy strong/small` 是本页 px 刻度字号（12px / 9px）
                          的落点；纵向排布与两行截断已由共享组件承担。 */}
                      <AgentCatalogIndexCopy
                        className="mcp-directory-copy"
                        title={getMcpDisplayName(server)}
                        subtitle={server.summary || t("directory.noDescription")}
                      />
                      {/* 同理，本页只留 meta 列的宽度（110px）、行距与字号；右对齐由共享组件给。 */}
                      <AgentCatalogIndexMeta className="mcp-directory-meta">
                        <span className="mcp-directory-organization" title={server.organizationName}>
                          {server.organizationName ?? t(`type.${server.type === "local" ? "local" : "remote"}`)}
                        </span>
                        {publiclyReadable ? <b>{t("scope.public")}</b> : null}
                        {external && !publiclyReadable ? <b>{t("scope.shared")}</b> : null}
                      </AgentCatalogIndexMeta>
                      {/* 宽度是本页 px 刻度（12px）；共享组件默认 `w-3` 在 13px 根字号下只有 9.75px，
                          故用本页类名覆盖，而不是依赖「箭头是按钮的直接子元素」这种 DOM 形状。 */}
                      <AgentCatalogIndexArrow className="mcp-directory-arrow" />
                    </AgentCatalogIndexItem>
                  );
                })}
              </AgentCatalogIndexNav>
            </AgentCatalogIndex>
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
  const external = isExternalMcp(server, props.activeOrganizationId);
  const publiclyReadable = server.scope?.visibility === "public";
  const Icon = getMcpIcon(server);
  return (
    <AgentMasterDetailHeader className="mcp-detail-header">
      <div className="mcp-detail-identity">
        <span className="mcp-detail-icon">{external ? <Share2 /> : <Icon />}</span>
        <div>
          <h2>{getMcpDisplayName(server)}</h2>
          <div className="mcp-detail-meta">
            <span>{server.organizationName ?? t("scope.organization")}</span>
            {publiclyReadable ? <b>{t("scope.public")}</b> : null}
            {external && !publiclyReadable ? <b>{t("scope.shared")}</b> : null}
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
          {tComponents(server.scope?.visibility === "public" ? "resource.makePrivate" : "resource.makePublic")}
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
  const { t } = useTranslation(NS.MCP);
  // 骨架屏本身没有可读内容，屏幕阅读器只会看到一片空白：文案走 sr-only 的 role="status"，
  // 容器再用 aria-busy 标出整块仍在加载（与 sandbox 面板的状态语义一致）。
  return (
    <AppPage className="agent-mcp-page" busy>
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
