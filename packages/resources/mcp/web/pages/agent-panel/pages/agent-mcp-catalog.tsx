import {
  AgentCatalogIndex,
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
  getMcpCatalogName,
  getMcpKey,
  isExternalMcp,
} from "../../../lib/mcp-resource-access";
import { countMcpScopes, filterMcpServers, isUnauthorizedError, type McpCatalogScope } from "./agent-mcp-utils";
import "./agent-mcp-catalog.css";

/**
 * 详情区里「一处定义、多处复用」的类串——原先是 `agent-mcp-catalog.css` 里命中同一批元素的结构选择器规则
 * （`.mcp-detail-facts > div` / `dt` / `dd` 拆给事实单元的四个格子，`.mcp-detail-meta b` 拆给两个角标）。
 * 取值与换算见该样式表的文件头：字号 / 间距取最近标准档、颜色取最近标准色阶、px ÷ 4 落刻度类。
 */
const FACT_CELL = "rounded border border-slate-200 p-3";
const FACT_LABEL = "text-3xs text-slate-400";
/**
 * 事实取值的基础类串与两种颜色（中性 / 启用态）。
 *
 * 两种颜色**互斥**而不是「基类 + 覆盖类」：两条 `text-*` 颜色工具类同层同特指度，同时挂在元素上时胜负交给
 * 产物里的生成顺序（实测 `slate` 生成在 `emerald` 之后，会把启用态压回中性色），故按状态择一拼装。
 */
const FACT_VALUE = "mt-1.25 text-xs font-semibold";
const FACT_VALUE_NEUTRAL = `${FACT_VALUE} text-slate-800`;
const FACT_VALUE_ENABLED = `${FACT_VALUE} text-emerald-600`;
/** 公开 / 共享角标：原 `.mcp-detail-meta b` 的描边 / 底色 / 字色都是同值色阶（`blue-200` / `blue-50` / `blue-700`）。 */
const META_BADGE =
  "rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.75 text-3xs font-semibold whitespace-nowrap text-blue-700";

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
          // 尺寸不手写：页头动作区统一走 `Button` 默认档（36px 高 / 16px 内距 / 6px 圆角）。本按钮此前另占一档
          // （`mcp-create-button`：40px 高 / 7px 间隙 / 8px 圆角 / 左右各 15px / 650 字重 / 15px 图标），
          // 2026-09-29 随全站页头一并收敛，该语义类名在 CSS 里也无规则，随之摘除。
          <Button onClick={props.onCreate}>
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
          className="mcp-master-detail flex-1"
          detailHeader={selectedServer ? <McpDetailHeader server={selectedServer} props={props} /> : null}
          detailFooter={selectedServer ? <McpDetailActions server={selectedServer} props={props} /> : null}
          index={
            // 目录栏外观（内边距 / 底色 / 分隔线 / 行距 / 条目三态 / 图标盒 / 字号）全在共享组件
            // `agent-catalog-index.tsx` 的 `className`（伴生 CSS 只剩工具类表达不了的三类：挂不上类名的内层
            // svg 与尾注 `<span>`、外壳的列模板、窄屏媒体块），页面不再给目录栏与条目任何取值——2026-09-23
            // 的裁定是「全部样式统一」。
            <AgentCatalogIndex
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
                      // `selected` 产出 `aria-current="page"`：既是读屏的「当前页」契约，也是共享组件
                      // `className` 变体（选中配色 `aria-[current=page]:…`、箭头显隐
                      // `group-aria-[current=page]:opacity-100`）的**唯一**依据（本页不必自己标类名）。
                      selected={active}
                      onClick={() => setSelectedKey(key)}
                    >
                      <AgentCatalogIndexIcon>{external ? <Share2 /> : <Icon />}</AgentCatalogIndexIcon>
                      <AgentCatalogIndexCopy
                        // 标题只取资源名：归属组织由紧随其后的组织角标单独展示，拼进标题会让同一个组织名
                        // 在同一行出现两次，并把标题列挤到截断（先例与判据见 `getMcpCatalogName`）。
                        title={getMcpCatalogName(server)}
                        subtitle={server.summary || t("directory.noDescription")}
                      />
                      {/* 尾注里的每个标签都是一个 `<span>`（共享 CSS 按这个约定给形态——这些节点由页面渲染、
                          挂不上类名）；`title` 保留全文，因为组织名会在列宽上限 100px（`max-w-25`）处被截断。 */}
                      <AgentCatalogIndexMeta>
                        <span title={server.organizationName}>
                          {server.organizationName ?? t(`type.${server.type === "local" ? "local" : "remote"}`)}
                        </span>
                        {publiclyReadable ? <span>{t("scope.public")}</span> : null}
                        {external && !publiclyReadable ? <span>{t("scope.shared")}</span> : null}
                      </AgentCatalogIndexMeta>
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
    // 详情头部 / 图标盒 / 元信息行 / 正文 / 事实栅格 / 工具区 / 动作区的尺寸与间距都是设计值，由工具类
    // 承担（刻度已在 `@theme` 按 px 落地）：112px / 56px / 8px / 32px / 12px… = `min-h-28` / `size-14` /
    // `gap-2` / `p-8` / `gap-3`…；下分隔线是原页面表的 `border-bottom: 1px solid #e7ecf3`，按色阶口径落
    // `border-b border-slate-200`。`AgentMasterDetailHeader` 用模板字符串拼 `className`，但它自带的是
    // `bg-surface-1`，与这些工具类不同族，合并后无冲突。
    <AgentMasterDetailHeader className="mcp-detail-header flex min-h-28 items-center justify-between gap-6 border-b border-slate-200 py-6 px-8">
      <div className="mcp-detail-identity flex min-w-0 items-center gap-4">
        {/* 图标盒：10px 圆角与两个页面变量色分别落 `rounded-lg`（12px，与 `rounded` 等距、取大）、
            `bg-blue-50`（#edf3ff）、`text-blue-600`（#2463eb）；内层图标 24px 是设计值，落 `size-6`。 */}
        <span className="mcp-detail-icon grid size-14 flex-none place-items-center rounded-lg bg-blue-50 text-blue-600">
          {external ? <Share2 className="size-6" /> : <Icon className="size-6" />}
        </span>
        <div>
          {/* 标题：22px 与 `text-xl`(20px) / `text-2xl`(24px) 等距，按本轮「等距取大」落 `text-2xl`；
              `truncate` 一次承担原来的 `overflow` / `text-overflow` / `white-space` 三条声明；
              `margin: 0 0 6px` → `mb-1.5`（其余三边本就为 0）。名称与目录条目同源（`getMcpCatalogName`），
              来源组织由下一行的元信息承载，不重复拼进标题。 */}
          <h2 className="truncate mb-1.5 text-2xl font-bold text-slate-800">{getMcpCatalogName(server)}</h2>
          {/* 元信息行：11px 与 `text-3xs`(10px) / `text-xs`(12px) 等距，按「等距取大」落 `text-xs`；
              字色 #96a2b5 → `slate-400`。 */}
          <div className="mcp-detail-meta flex items-center gap-2 text-xs text-slate-400">
            <span>{server.organizationName ?? t("scope.organization")}</span>
            {publiclyReadable ? <b className={META_BADGE}>{t("scope.public")}</b> : null}
            {external && !publiclyReadable ? <b className={META_BADGE}>{t("scope.shared")}</b> : null}
          </div>
        </div>
      </div>
      {/* 详情面板动作位不手写尺寸：与页头动作区同档，走 `Button` 默认档（36px 高 / 16px 内距 / 6px 圆角）。 */}
      <Button variant="ghost" onClick={() => props.onOpen(server)}>
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
    <article className="mcp-detail-body min-w-0 p-8">
      {/* 摘要块：底色 #f5f8fc → `bg-slate-50`；小标题 10px / 700 / 0.1em / #2463eb → `text-3xs` /
          `font-bold` / `tracking-widest`（同值）/ `text-blue-600`；正文 13px / 1.7 / #65728a / 760px →
          `text-13` / `leading-relaxed`(1.625) / `text-slate-500` / `max-w-3xl`(768px)。 */}
      <section className="mcp-detail-summary rounded bg-slate-50 px-5 py-4">
        <span className="text-3xs font-bold tracking-widest text-blue-600">MCP</span>
        <p className="mt-2.5 max-w-3xl text-13 leading-relaxed text-slate-500">
          {server.summary || t("directory.noDescription")}
        </p>
      </section>
      {/* 事实栅格：格子 / 标签 / 取值的类串见模块顶部常量（原 `.mcp-detail-facts > div` / `dt` / `dd`
          三条结构选择器；启用态的 `.is-enabled` 改成颜色二选一）。窄屏改两列的媒体查询仍在
          `agent-mcp-catalog.css`（900px 不是标准断点）。 */}
      <dl className="mcp-detail-facts grid grid-cols-4 gap-3 mt-5">
        <div className={FACT_CELL}>
          <dt className={FACT_LABEL}>{t("column.type")}</dt>
          <dd className={FACT_VALUE_NEUTRAL}>{t(`type.${server.type === "local" ? "local" : "remote"}`)}</dd>
        </div>
        <div className={FACT_CELL}>
          <dt className={FACT_LABEL}>{t("column.status")}</dt>
          <dd className={server.enabled ? FACT_VALUE_ENABLED : FACT_VALUE_NEUTRAL}>
            {server.enabled ? t("status.enabled") : t("status.disabled")}
          </dd>
        </div>
        <div className={FACT_CELL}>
          <dt className={FACT_LABEL}>{t("column.tools")}</dt>
          <dd className={FACT_VALUE_NEUTRAL}>
            {t("directory.toolCount", {
              count: server.toolsCount ?? tools.length,
            })}
          </dd>
        </div>
        <div className={FACT_CELL}>
          <dt className={FACT_LABEL}>{t("directory.details")}</dt>
          <dd className={FACT_VALUE_NEUTRAL}>{server.type === "local" ? "stdio" : "HTTP"}</dd>
        </div>
      </dl>
      {/* 工具区：上分隔线 `1px solid #e7ecf3` → `border-t border-slate-200`；头部行距 16px 与两端对齐、
          下距 12px → `flex items-center justify-between gap-4 mb-3`；标题 13px / 600 / #17233a →
          `text-13 font-semibold text-slate-800`；副文案 3px / 10px / #96a2b5 → `mt-0.75 text-3xs
          text-slate-400`。 */}
      <section className="mcp-detail-tools mt-6 border-t border-slate-200 pt-6">
        <header className="flex items-center justify-between gap-4 mb-3">
          <div>
            <h3 className="text-13 font-semibold text-slate-800">{t("column.tools")}</h3>
            <p className="mt-0.75 text-3xs text-slate-400">{t("directory.toolCount", { count: tools.length })}</p>
          </div>
          {/* 工具区右上角动作位同上：尺寸不手写，与页头动作区同档。 */}
          <Button variant="outline" disabled={loading} onClick={() => props.onInspect(server)}>
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
  // `resource.*` 角标与公开/私有动作词表归 `@fenix/ui-components`（`StatusBadge` 的同名默认文案），
  // 随台账 D4 从宿主 `components` 字典改指该包命名空间。
  const { t: tComponents } = useTranslation(NS.UI_COMPONENTS);
  const writable = canWriteMcp(server);
  const manageable = canManageMcpSharing(server);
  return (
    // 底部动作区的上分隔线是原页面表的 `border-top: 1px solid #e7ecf3`，按色阶口径落 `border-t border-slate-200`；
    // 动作按钮同样不手写尺寸（与页头动作区同档，`Button` 默认 36px 高）。
    <div className="mcp-detail-actions flex min-h-16 items-center gap-1.5 border-t border-slate-200 px-8 py-3">
      <Button variant="outline" onClick={() => props.onInspect(server)}>
        <RefreshCw /> {t("btn.inspect")}
      </Button>
      {writable ? (
        <Button variant="ghost" onClick={() => props.onToggleEnabled(server)}>
          <CheckCircle2 /> {server.enabled ? t("btn.disable") : t("btn.enable")}
        </Button>
      ) : null}
      {manageable ? (
        <Button variant="ghost" disabled={props.sharing} onClick={() => props.onToggleSharing(server)}>
          <Share2 />
          {tComponents(server.scope?.visibility === "public" ? "resource.makePrivate" : "resource.makePublic")}
        </Button>
      ) : null}
      {writable ? (
        <Button
          variant="ghost"
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
    // 工具清单：描边 `1px solid #e7ecf3` → `border border-slate-200`；底色 #fafbfd → `bg-slate-50`。
    <section
      className="mcp-tool-list grid overflow-hidden rounded border border-slate-200 bg-slate-50"
      aria-busy={loading}
    >
      {loading ? (
        // 加载态：上下 14px / 左右 16px 内边距 → `px-4 py-3.5`；10px 与 #96a2b5 → `text-3xs text-slate-400`；
        // 图标 13px → `w-3.25`（原声明只给宽度，高度一直是 lucide 的 24px 属性值，本轮不动），
        // `animation: mcp-spin 0.9s linear infinite` → `animate-spin`（1s 标准档；本表的 `@keyframes` 已删）。
        <span className="mcp-tools-loading flex items-center gap-1.5 px-4 py-3.5 text-3xs text-slate-400">
          <RefreshCw className="w-3.25 animate-spin" /> {t("btn.inspecting")}
        </span>
      ) : tools.length === 0 ? (
        <p className="px-4 py-3.5 text-3xs text-slate-400">{t("tools.noTools")}</p>
      ) : (
        tools.map((tool) => (
          // 工具行：两列栅格（`minmax()` 复合值）与 `inset` 投影工具类表达不了，留在 `agent-mcp-catalog.css`；
          // 排布与 16px / 12×16px 的间距落 `grid gap-4 px-4 py-3`。描述行原有一条「内边距归零」的后代规则，
          // 现在这行不给内边距，规则连同一起删除。
          <div key={tool.id} className="grid gap-4 px-4 py-3">
            <strong className="truncate font-mono text-3xs text-slate-800">{tool.toolName}</strong>
            <span className="text-3xs text-slate-400">{tool.description || t("directory.noDescription")}</span>
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
