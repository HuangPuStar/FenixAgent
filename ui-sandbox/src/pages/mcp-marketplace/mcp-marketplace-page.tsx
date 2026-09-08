import { Check, ChevronRight, CircleCheck, Copy, Download, Search, SlidersHorizontal, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ResourceScopeFilter } from "../../components/resource-scope-filter";
import { Modal, PageHeader, PrimaryButton, SearchToolbar, Toast, ToolbarSummary } from "../../components/ui";
import { MARKETPLACE_SCOPES, type MarketplaceScope } from "../../lib/resource-scope";
import { type MarketplaceMcpServer, MCP_MARKETPLACE_SERVERS, toMcpJson } from "./mcp-marketplace-data";

const CATEGORIES = ["全部", "开发工具", "数据", "浏览器", "云服务"] as const;
type MarketplaceFilter = (typeof CATEGORIES)[number] | "已安装";

export function McpMarketplacePage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MarketplaceFilter>("全部");
  const [scope, setScope] = useState<MarketplaceScope>("全部");
  const [installed, setInstalled] = useState(() => new Set(["filesystem", "browser-control", "github"]));
  const [selected, setSelected] = useState<MarketplaceMcpServer | null>(null);
  const [toast, setToast] = useState("");

  const servers = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return MCP_MARKETPLACE_SERVERS.filter(
      (server) =>
        (scope === "全部" || server.scope === scope) &&
        (filter === "全部" || (filter === "已安装" ? installed.has(server.id) : server.category === filter)) &&
        (!keyword || `${server.name} ${server.publisher} ${server.description}`.toLowerCase().includes(keyword)),
    );
  }, [filter, installed, query, scope]);

  const scopeCounts: Record<MarketplaceScope, number> = {
    全部: MCP_MARKETPLACE_SERVERS.length,
    个人: MCP_MARKETPLACE_SERVERS.filter((server) => server.scope === "个人").length,
    本组织: MCP_MARKETPLACE_SERVERS.filter((server) => server.scope === "本组织").length,
    平台: MCP_MARKETPLACE_SERVERS.filter((server) => server.scope === "平台").length,
    市场: MCP_MARKETPLACE_SERVERS.filter((server) => server.scope === "市场").length,
  };

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const copyJson = (server: MarketplaceMcpServer) => {
    void navigator.clipboard.writeText(toMcpJson(server)).then(
      () => setToast("MCP JSON 已复制"),
      () => setToast("复制失败，请重试"),
    );
  };

  const toggleInstall = (server: MarketplaceMcpServer) => {
    const nextInstalled = !installed.has(server.id);
    setInstalled((current) => {
      const next = new Set(current);
      nextInstalled ? next.add(server.id) : next.delete(server.id);
      return next;
    });
    setSelected(null);
    setToast(nextInstalled ? `${server.name} 已添加` : `${server.name} 已移除`);
  };

  return (
    <div className="page-frame mcp-marketplace">
      <PageHeader
        title="MCP 插件市场"
        description="查找经过整理的 MCP Server，通过标准 JSON 添加文件、浏览器、代码仓库与业务系统能力。"
      >
        <PrimaryButton onClick={() => setToast("私有 MCP 发布入口（Mock）")}>添加私有插件</PrimaryButton>
      </PageHeader>

      <SearchToolbar
        value={query}
        onChange={setQuery}
        placeholder={filter === "已安装" ? "搜索已安装插件" : "搜索插件、发布方或用途"}
        shortcut="⌘ K"
        className="mcp-marketplace__controls"
      >
        <ResourceScopeFilter value={scope} onChange={setScope} counts={scopeCounts} options={MARKETPLACE_SCOPES} />
        <ToolbarSummary>
          <span>
            <strong>{servers.length}</strong> 个结果
          </span>
          <span>
            <Wrench /> {MCP_MARKETPLACE_SERVERS.reduce((sum, server) => sum + server.tools, 0)} 个工具
          </span>
          <span>
            <Check /> {installed.size} 已添加
          </span>
        </ToolbarSummary>
      </SearchToolbar>

      <section className="mcp-marketplace__catalog">
        <header>
          <div>
            <h3>插件目录</h3>
            <span>{servers.length} 个结果</span>
          </div>
          <nav aria-label="MCP 插件分类">
            <button
              type="button"
              className={`is-installed-filter${filter === "已安装" ? " is-active" : ""}`}
              aria-pressed={filter === "已安装"}
              onClick={() => setFilter("已安装")}
            >
              <Check /> 已安装 <span>{installed.size}</span>
            </button>
            {CATEGORIES.map((item) => (
              <button
                type="button"
                className={filter === item ? "is-active" : ""}
                aria-pressed={filter === item}
                onClick={() => setFilter(item)}
                key={item}
              >
                {item}
              </button>
            ))}
          </nav>
          <button type="button" aria-label="筛选插件" onClick={() => setToast("当前已按分类筛选")}>
            <SlidersHorizontal />
          </button>
        </header>

        {servers.length === 0 ? (
          <div className="mcp-marketplace__empty">
            <Search />
            <strong>{filter === "已安装" ? "没有已安装的插件" : "没有匹配的插件"}</strong>
            <span>{filter === "已安装" ? "从全部插件中添加需要的能力。" : "换一个名称、发布方或分类试试。"}</span>
          </div>
        ) : (
          <div className="mcp-plugin-grid">
            {servers.map((server) => {
              const Icon = server.icon;
              const active = installed.has(server.id);
              return (
                <article
                  className="mcp-plugin-card"
                  key={server.id}
                  style={{ "--mcp-accent": server.accent } as React.CSSProperties}
                >
                  <header>
                    <span className="mcp-plugin-card__icon">
                      <Icon />
                    </span>
                    <div>
                      <h4>{server.name}</h4>
                      <small>{server.publisher}</small>
                    </div>
                    {active && (
                      <span className="mcp-plugin-card__installed">
                        <Check /> 已添加
                      </span>
                    )}
                  </header>
                  <div className="mcp-plugin-card__badges">
                    <span
                      className={`mcp-plugin-card__scope is-${server.scope === "个人" ? "personal" : server.scope === "本组织" ? "org" : server.scope === "平台" ? "platform" : "market"}`}
                    >
                      {server.scope}
                    </span>
                    <span className={server.verified ? "is-verified" : ""}>
                      <CircleCheck /> {server.verified ? "已验证" : "社区"}
                    </span>
                    <span>
                      <Wrench /> {server.tools} 个工具
                    </span>
                  </div>
                  <p>{server.description}</p>
                  <div className="mcp-plugin-card__meta">
                    <span>{server.category}</span>
                    <span>更新于 {server.updatedAt}</span>
                  </div>
                  <footer>
                    <span>
                      {server.transport} · {server.installs} 次添加
                    </span>
                    <button type="button" onClick={() => setSelected(server)}>
                      {active ? "管理" : "查看"} <ChevronRight />
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {selected && (
        <Modal
          title={`${selected.name} · MCP JSON`}
          onClose={() => setSelected(null)}
          confirmText={installed.has(selected.id) ? "移除插件" : "添加插件"}
          onConfirm={() => toggleInstall(selected)}
        >
          <div className="mcp-json-detail">
            <div>
              <span style={{ "--mcp-accent": selected.accent } as React.CSSProperties}>
                <selected.icon />
              </span>
              <p>{selected.description}</p>
              <button type="button" onClick={() => copyJson(selected)}>
                <Copy /> 复制 JSON
              </button>
            </div>
            <pre>{toMcpJson(selected)}</pre>
            <small>
              <Download /> 配置保存后由 Agent 运行时读取；本页不连接任何线上 MCP Server。
            </small>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast} />}
    </div>
  );
}
