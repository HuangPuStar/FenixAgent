import { useRequest } from "ahooks";
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { mcpApi } from "@/src/api/mcp";
import { unwrap } from "@/src/api/request";
import {
  canManageMcpSharing,
  canWriteMcp,
  getMcpDisplayName,
  getMcpKey,
  getMcpLookupKey,
  getMcpResourceBadgeKey,
} from "@/src/lib/mcp-resource-access";
import { NS } from "../../../i18n";
import type { McpServerConfig, McpServerInfo, McpToolInfo } from "../../../types/config";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

type KeyValueEntry = { key: string; value: string };

function validateMcpForm(
  name: string,
  type: "local" | "remote",
  command: string,
  url: string,
  t: (key: string) => string,
): string | null {
  if (!name.trim()) return t("validation.nameRequired");
  if (/--/.test(name)) return t("validation.nameNoDoubleHyphen");
  if (!/^[\p{L}0-9](?:[\p{L}0-9-]*[\p{L}0-9])?$/u.test(name)) return t("validation.namePattern");
  if (name.length > 64) return t("validation.nameTooLong");
  if (type === "local") {
    if (!command.trim()) return t("validation.commandRequired");
    const parts = parseCommandString(command);
    if (parts.length === 0) return t("validation.commandInvalid");
  }
  if (type === "remote") {
    if (!url.trim()) return t("validation.urlRequired");
    try {
      new URL(url);
    } catch {
      return t("validation.urlInvalid");
    }
  }
  return null;
}

function parseCommandString(input: string): string[] {
  const tokens: string[] = [];
  const regex = /(?:[^\s"]+|"[^"]*")+/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
  while ((match = regex.exec(input)) !== null) {
    tokens.push(match[0].replace(/^"|"$/g, ""));
  }
  return tokens;
}

function commandToString(command: string[]): string {
  return command.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

function buildMcpPayload(
  type: "local" | "remote",
  command: string,
  url: string,
  environment: KeyValueEntry[],
  headers: KeyValueEntry[],
  oauthClientId: string,
  oauthClientSecret: string,
  oauthScope: string,
  oauthRedirectUri: string,
  timeout: string,
): McpServerConfig {
  const timeoutNum = timeout ? parseInt(timeout, 10) : undefined;
  const envObj: Record<string, string> | undefined =
    environment.filter((e) => e.key.trim()).length > 0
      ? Object.fromEntries(environment.filter((e) => e.key.trim()).map((e) => [e.key, e.value]))
      : undefined;
  const headersObj: Record<string, string> | undefined =
    headers.filter((h) => h.key.trim()).length > 0
      ? Object.fromEntries(headers.filter((h) => h.key.trim()).map((h) => [h.key, h.value]))
      : undefined;
  const oauthObj =
    oauthClientId || oauthClientSecret || oauthScope || oauthRedirectUri
      ? {
          clientId: oauthClientId || undefined,
          clientSecret: oauthClientSecret || undefined,
          scope: oauthScope || undefined,
          redirectUri: oauthRedirectUri || undefined,
        }
      : undefined;
  if (type === "local") {
    return {
      type: "local",
      command: parseCommandString(command),
      ...(envObj ? { environment: envObj } : {}),
      ...(timeoutNum ? { timeout: timeoutNum } : {}),
    };
  }
  return {
    type: "remote",
    url,
    ...(headersObj ? { headers: headersObj } : {}),
    ...(oauthObj ? { oauth: oauthObj } : {}),
    ...(timeoutNum ? { timeout: timeoutNum } : {}),
  };
}

export function AgentMcpPage() {
  const { t } = useTranslation("mcp");
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // 列表查询
  const {
    data: listData,
    loading,
    error: listError,
    refresh,
  } = useRequest(() => unwrap(mcpApi.list()), {
    onError: (err) => {
      console.error(t("toast.loadListFailed"), err);
      toast.error(t("toast.loadListFailedWith", { message: err.message }));
    },
  });
  const servers = Array.isArray(listData?.servers) ? listData.servers : [];

  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState<"local" | "remote">("remote");
  const [formCommand, setFormCommand] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formEnvironment, setFormEnvironment] = useState<KeyValueEntry[]>([{ key: "", value: "" }]);
  const [formHeaders, setFormHeaders] = useState<KeyValueEntry[]>([{ key: "", value: "" }]);
  const [formTimeout, setFormTimeout] = useState("");

  // 保存（创建/更新）：仅创建时 toast 提示
  const { run: runSave, loading: saving } = useRequest(
    async (payload: McpServerConfig) => {
      if (editingServer) {
        return unwrap(mcpApi.update(formName, payload));
      }
      return unwrap(mcpApi.create(formName, payload));
    },
    {
      manual: true,
      onSuccess: () => {
        if (!editingServer) toast.success(t("toast.serverCreated"));
        setDialogOpen(false);
        refresh();
      },
      onError: (err) => {
        console.error(t("toast.saveFailed"), err);
        toast.error(t("toast.saveFailedWith", { message: err.message }));
      },
    },
  );

  // 启停切换：静默操作，UI 已视觉反馈
  const { run: runToggle } = useRequest(
    async (server: McpServerInfo) => {
      if (server.enabled) {
        return unwrap(mcpApi.disable(server.name));
      }
      return unwrap(mcpApi.enable(server.name));
    },
    {
      manual: true,
      onSuccess: () => refresh(),
      onError: (err) => {
        console.error(t("toast.operationFailed"), err);
        toast.error(t("toast.operationFailedWith", { message: err.message }));
      },
    },
  );

  // 删除：静默操作，列表项消失已是最佳反馈
  const { run: runDelete } = useRequest((name: string) => unwrap(mcpApi.del(name)), {
    manual: true,
    onSuccess: () => {
      setConfirmOpen(false);
      refresh();
    },
    onError: (err) => {
      console.error(t("toast.deleteFailed"), err);
      toast.error(t("toast.deleteFailedWith", { message: err.message }));
    },
  });

  // 公开/私密切换
  const { run: runToggleSharing, loading: sharingLoading } = useRequest(
    async (server: McpServerInfo) => {
      if (!canManageMcpSharing(server) || !server.resourceAccess) throw new Error("无法管理此服务器的共享状态");
      const nextPublicReadable = !server.resourceAccess.publicReadable;
      const data = await unwrap(mcpApi.get(getMcpLookupKey(server)));
      // publicReadable 由后端 splitMcpConfigInput 从 config 对象中提取
      const configWithSharing = { ...data.config, publicReadable: nextPublicReadable };
      await unwrap(mcpApi.update(server.name, configWithSharing as McpServerConfig));
      return { nextPublicReadable };
    },
    {
      manual: true,
      onSuccess: ({ nextPublicReadable }: { nextPublicReadable: boolean }) => {
        toast.success(nextPublicReadable ? tComponents("resource.makePublic") : tComponents("resource.makePrivate"));
        refresh();
      },
      onError: (err) => {
        console.error(t("toast.saveFailed"), err);
        toast.error(t("toast.saveFailedWith", { message: err.message }));
      },
    },
  );

  const [oauthExpanded, setOauthExpanded] = useState(false);
  const [formOauthClientId, setFormOauthClientId] = useState("");
  const [formOauthClientSecret, setFormOauthClientSecret] = useState("");
  const [formOauthScope, setFormOauthScope] = useState("");
  const [formOauthRedirectUri, setFormOauthRedirectUri] = useState("");

  const [testingUrl, setTestingUrl] = useState(false);
  const [inspectingServer, setInspectingServer] = useState<string | null>(null);
  const [toolsCache, setToolsCache] = useState<Record<string, McpToolInfo[]>>({});
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const editingReadOnly = editingServer ? !canWriteMcp(editingServer) : false;

  const handleOpenCreate = () => {
    setEditingServer(null);
    setFormName("");
    setFormType("remote");
    setFormCommand("");
    setFormUrl("");
    setFormEnvironment([{ key: "", value: "" }]);
    setFormHeaders([{ key: "", value: "" }]);
    setFormTimeout("");
    setFormOauthClientId("");
    setFormOauthClientSecret("");
    setFormOauthScope("");
    setFormOauthRedirectUri("");
    setOauthExpanded(false);
    setDialogOpen(true);
  };

  const handleOpenEdit = async (server: McpServerInfo) => {
    setEditingServer(server);
    setFormName(server.name);
    const { success, data: detail, error: detailError } = await mcpApi.get(getMcpLookupKey(server));
    if (!success || !detail) {
      console.error(t("toast.loadDetailFailed"), detailError);
      toast.error(t("toast.loadDetailFailed"));
    } else {
      const config = detail.config;
      if ("type" in config && config.type === "local") {
        setFormType("local");
        setFormCommand(commandToString(config.command));
        setFormEnvironment(
          config.environment
            ? Object.entries(config.environment).map(([key, value]) => ({ key, value: String(value) }))
            : [{ key: "", value: "" }],
        );
        setFormHeaders([{ key: "", value: "" }]);
        setFormTimeout(config.timeout != null ? String(config.timeout) : "");
        setFormUrl("");
        setFormOauthClientId("");
        setFormOauthClientSecret("");
        setFormOauthScope("");
        setFormOauthRedirectUri("");
        setOauthExpanded(false);
      } else if ("type" in config && config.type === "remote") {
        setFormType("remote");
        setFormUrl(config.url);
        setFormHeaders(
          config.headers
            ? Object.entries(config.headers).map(([key, value]) => ({ key, value: String(value) }))
            : [{ key: "", value: "" }],
        );
        setFormEnvironment([{ key: "", value: "" }]);
        setFormCommand("");
        setFormTimeout(config.timeout != null ? String(config.timeout) : "");
        if (config.oauth && typeof config.oauth === "object") {
          setFormOauthClientId(config.oauth.clientId ?? "");
          setFormOauthClientSecret(config.oauth.clientSecret ?? "");
          setFormOauthScope(config.oauth.scope ?? "");
          setFormOauthRedirectUri(config.oauth.redirectUri ?? "");
          setOauthExpanded(true);
        } else {
          setFormOauthClientId("");
          setFormOauthClientSecret("");
          setFormOauthScope("");
          setFormOauthRedirectUri("");
          setOauthExpanded(false);
        }
      }
    }
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const err = validateMcpForm(formName, formType, formCommand, formUrl, t);
    if (err) {
      toast.error(err);
      return;
    }
    const payload = buildMcpPayload(
      formType,
      formCommand,
      formUrl,
      formEnvironment,
      formHeaders,
      formOauthClientId,
      formOauthClientSecret,
      formOauthScope,
      formOauthRedirectUri,
      formTimeout,
    );
    runSave(payload);
  };

  const handleInspect = async (server: McpServerInfo) => {
    const writable = canWriteMcp(server);
    const serverKey = getMcpKey(server);
    setInspectingServer(serverKey);
    // 外部只读 MCP server 用 listTools 获取缓存工具，内部用 inspect 连接实时检测
    if (writable) {
      const { success, data: result, error } = await mcpApi.inspect(server.name);
      if (!success || !result || error) {
        console.error(t("toast.inspectFailed"), error);
        toast.error(t("toast.inspectFailedWith", { message: error?.message ?? t("toast.saveFailed") }));
        setInspectingServer(null);
        return;
      }
      toast.success(
        t("toast.inspectSuccess", {
          name: server.name,
          serverInfo: result.serverInfo.name ?? "",
          version: result.serverInfo.version ?? "",
          toolCount: result.tools.length,
        }),
      );
      refresh();
      setToolsCache((prev) => ({
        ...prev,
        [serverKey]: result.tools.map((toolItem) => ({
          id: `${serverKey}:${toolItem.name}`,
          toolName: toolItem.name,
          description: toolItem.description ?? null,
          inputSchema: toolItem.inputSchema ? JSON.stringify(toolItem.inputSchema) : null,
          inspectedAt: Date.now(),
        })),
      }));
    } else {
      const { success, data: result, error } = await mcpApi.listTools(server.name);
      if (!success || !result || error) {
        console.error(t("toast.inspectFailed"), error);
        toast.error(t("toast.inspectFailedWith", { message: error?.message ?? t("toast.saveFailed") }));
        setInspectingServer(null);
        return;
      }
      toast.success(t("toast.inspectSuccess", { name: server.name, version: "", toolCount: result.tools.length }));
      setToolsCache((prev) => ({
        ...prev,
        [serverKey]: result.tools.map((toolItem) => ({
          id: toolItem.id || `${serverKey}:${toolItem.toolName}`,
          toolName: toolItem.toolName,
          description: toolItem.description ?? null,
          inputSchema: toolItem.inputSchema ? JSON.stringify(toolItem.inputSchema) : null,
          inspectedAt: toolItem.inspectedAt ?? Date.now(),
        })),
      }));
    }
    setExpandedServer(serverKey);
    setInspectingServer(null);
  };

  const handleTestFormUrl = async () => {
    if (!formUrl.trim()) return;
    setTestingUrl(true);
    const { success, data: result, error: testError } = await mcpApi.testUrl(formUrl);
    if (!success || !result || testError) {
      console.error(t("toast.testFailed"), testError);
      toast.error(t("toast.testFailedWith", { message: testError?.message ?? "测试失败" }));
    } else if (result.reachable && result.protocol) {
      const toolsInfo = result.toolsCount != null ? `，${result.toolsCount} ${t("column.tools").toLowerCase()}` : "";
      toast.success(
        t("toast.testSuccess", {
          serverName: result.serverName ?? "",
          serverVersion: result.serverVersion ?? "",
          toolsInfo,
        }),
      );
    } else if (result.reachable) {
      toast.warning(t("toast.testReachable", { message: result.message ?? "" }));
    } else {
      toast.error(t("toast.testFailed", { message: result.message ?? t("toast.saveFailed") }));
    }
    setTestingUrl(false);
  };

  // 基于外部搜索过滤服务器列表
  const filteredServers = searchQuery.trim()
    ? servers.filter(
        (s) =>
          getMcpDisplayName(s).toLowerCase().includes(searchQuery.toLowerCase()) ||
          (s.summary ?? "").toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : servers;

  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <Skeleton className="h-[22px] w-28 rounded-md" />
            <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
          </div>
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
        <div className="mb-3.5 h-px bg-[#e8edf4]" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (listError) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
        <div className="flex flex-col items-center gap-3 py-16 text-text-muted">
          <p>{listError.message}</p>
          <button
            type="button"
            onClick={() => refresh()}
            className="inline-flex h-9 items-center rounded-lg border border-border bg-surface-1 px-4 text-sm hover:bg-surface-2"
          >
            {t("common.retry") ?? "重试"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <button
            type="button"
            onClick={handleOpenCreate}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-[#1677ff] px-[22px] text-[13px] font-semibold text-white shadow-[0_4px_14px_rgba(22,119,255,0.18)] transition hover:bg-[#0f67df]"
          >
            <Plus className="h-4 w-4" />
            {t("btn.newServer")}
          </button>
        }
      />

      {/* 通知条 */}
      <div className="mb-3.5 rounded-lg border border-border-light bg-warning/10 px-4 py-3 text-sm text-text-secondary">
        {t("resource.trustedNotice")}
      </div>

      {/* 搜索栏 */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a8bd]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("search")}
            className="h-10 w-full rounded-lg border border-[#dce5ef] bg-white pl-10 pr-4 text-[13px] text-[#1a2944] outline-none transition placeholder:text-[#99a8bc] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
          />
        </div>
      </div>

      <AgentCardList
        items={filteredServers}
        cardKey={(s) => getMcpKey(s)}
        emptyMessage={t("empty")}
        gridCols="grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
        renderCard={(server) => {
          const serverKey = getMcpKey(server);
          const isExpanded = expandedServer === serverKey;
          const tools = toolsCache[serverKey];
          const writable = canWriteMcp(server);
          const manageable = canManageMcpSharing(server);

          return (
            <div className="rounded-lg border border-border-light bg-surface-1 transition-colors hover:border-border-active hover:shadow-sm overflow-hidden">
              {/* ── 头部：类型标识 + 名称 + 徽章 ── */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
                <div
                  className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-base font-extrabold text-white ${
                    server.type === "local" ? "bg-amber-500" : server.type === "remote" ? "bg-cyan-500" : "bg-surface-2"
                  }`}
                >
                  {server.type === "local" ? "L" : server.type === "remote" ? "R" : "—"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-text-bright truncate">
                      {getMcpDisplayName(server)}
                    </span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${
                        server.type === "local"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                          : server.type === "remote"
                            ? "bg-cyan-subtle text-cyan dark:text-cyan"
                            : "bg-surface-2 text-text-muted"
                      }`}
                    >
                      {server.type === "local" ? "Local" : server.type === "remote" ? "Remote" : t("disabled")}
                    </span>
                  </div>
                  <p className="text-[11px] text-text-muted mt-0.5 truncate">{server.summary || "—"}</p>
                </div>
              </div>

              {/* ── 信息区：资源来源 + 状态 + 工具数 + 共享开关 ── */}
              <div className="px-4 py-2.5 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-surface-2 text-text-muted">
                    {tComponents(getMcpResourceBadgeKey(server))}
                  </span>
                  <span
                    className={`inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full text-xs font-medium ${
                      server.enabled
                        ? "bg-brand-subtle text-brand dark:text-brand-light"
                        : "bg-surface-2 text-text-muted"
                    }`}
                  >
                    {server.enabled ? t("btn.enable") : t("btn.disable")}
                  </span>
                  {(server.toolsCount ?? 0) > 0 && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-surface-2 text-text-muted">
                      {server.toolsCount} {t("column.tools").toLowerCase()}
                    </span>
                  )}
                </div>
                {manageable && (
                  <label className="flex items-center gap-2 text-xs text-text-muted">
                    <Switch
                      checked={Boolean(server.resourceAccess?.publicReadable)}
                      disabled={sharingLoading}
                      onCheckedChange={() => runToggleSharing(server)}
                    />
                    {tComponents("resource.public")}
                  </label>
                )}
                {!writable && <p className="text-xs font-medium text-text-muted">{tComponents("resource.readOnly")}</p>}
              </div>

              {/* ── 操作栏 ── */}
              <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border-subtle bg-surface-0 text-[11px]">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleInspect(server);
                    }}
                    disabled={inspectingServer === serverKey}
                    className="text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                  >
                    {inspectingServer === serverKey ? t("btn.inspecting") : t("btn.inspect")}
                  </button>
                  {writable && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        runToggle(server);
                      }}
                      className="text-text-secondary hover:text-text-primary transition-colors"
                    >
                      {server.enabled ? t("btn.disable") : t("btn.enable")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleOpenEdit(server);
                    }}
                    className="text-text-secondary hover:text-text-primary transition-colors"
                  >
                    {writable ? t("btn.edit") : t("btn.view")}
                  </button>
                  {(server.toolsCount ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (isExpanded) {
                          setExpandedServer(null);
                        } else {
                          if (tools && tools.length > 0) {
                            setExpandedServer(serverKey);
                          } else {
                            void handleInspect(server);
                          }
                        }
                      }}
                      className="text-text-secondary hover:text-text-primary transition-colors"
                    >
                      {isExpanded ? "▲" : "▼"}
                    </button>
                  )}
                </div>
                {writable && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteTarget(server.name);
                      setConfirmOpen(true);
                    }}
                    className="text-red-500 hover:text-red-600 transition-colors ml-auto"
                  >
                    {t("btn.delete")}
                  </button>
                )}
              </div>

              {/* ── 展开的工具列表 ── */}
              {isExpanded && tools && tools.length > 0 && (
                <div className="border-t border-border-subtle px-4 py-3 bg-surface-2/30 grid gap-2 max-h-72 overflow-y-auto">
                  {tools.map((tool) => (
                    <div key={tool.id} className="rounded-lg border border-border-light bg-surface-1 px-3 py-2.5">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <span className="font-mono text-sm font-medium text-text-bright">{tool.toolName}</span>
                          {tool.description && (
                            <p className="mt-0.5 text-xs text-text-secondary line-clamp-2">{tool.description}</p>
                          )}
                        </div>
                        {tool.inputSchema ? (
                          <details className="shrink-0">
                            <summary className="text-xs text-text-muted cursor-pointer hover:text-text-primary">
                              {t("form.parameters")}
                            </summary>
                            <pre className="mt-2 text-xs p-2.5 bg-surface-2 rounded-lg overflow-x-auto max-h-40 min-w-[200px] font-mono">
                              {(() => {
                                try {
                                  return JSON.stringify(JSON.parse(tool.inputSchema), null, 2);
                                } catch {
                                  return tool.inputSchema;
                                }
                              })()}
                            </pre>
                          </details>
                        ) : (
                          <span className="shrink-0 text-xs text-text-muted">{t("form.noParameters")}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={
          editingServer ? (editingReadOnly ? t("dialog.detailTitle") : t("dialog.editTitle")) : t("dialog.createTitle")
        }
        onSubmit={handleSave}
        loading={saving}
        hideSubmit={editingReadOnly}
        width="sm:max-w-2xl"
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.name")}</label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              disabled={editingReadOnly || !!editingServer}
              placeholder="my-mcp-server"
              className="mt-1 font-mono text-sm"
            />
            {editingServer && <p className="text-xs text-text-muted mt-1">{t("dialog.nameImmutable")}</p>}
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.type")}</label>
            <p className="text-xs text-text-muted mb-1.5">
              {formType === "local" ? t("form.typeLocalDesc") : t("form.typeRemoteDesc")}
            </p>
            <Select
              value={formType}
              onValueChange={(v) => setFormType(v as "local" | "remote")}
              disabled={editingReadOnly || !!editingServer}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">{t("form.typeLocalOption")}</SelectItem>
                <SelectItem value="remote">{t("form.typeRemoteOption")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {formType === "local" && (
            <>
              <div>
                <label className="text-sm font-medium text-text-primary">{t("form.command")}</label>
                <p className="text-xs text-text-muted mb-1.5">{t("form.commandHint")}</p>
                <Input
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  disabled={editingReadOnly}
                  placeholder="npx @anthropic/mcp-server-xxx --arg1 val1"
                  className="font-mono text-sm"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-text-primary">{t("form.environment")}</label>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={editingReadOnly}
                    onClick={() => setFormEnvironment([...formEnvironment, { key: "", value: "" }])}
                  >
                    {t("btn.add")}
                  </Button>
                </div>
                <div className="space-y-2">
                  {formEnvironment.map((entry, idx) => (
                    <div key={entry.key || `env-${idx}`} className="flex gap-2 items-center">
                      <Input
                        placeholder="KEY"
                        value={entry.key}
                        disabled={editingReadOnly}
                        onChange={(e) => {
                          const next = [...formEnvironment];
                          next[idx] = { ...next[idx], key: e.target.value };
                          setFormEnvironment(next);
                        }}
                        className="flex-1 font-mono text-sm"
                      />
                      <Input
                        placeholder="VALUE"
                        value={entry.value}
                        disabled={editingReadOnly}
                        onChange={(e) => {
                          const next = [...formEnvironment];
                          next[idx] = { ...next[idx], value: e.target.value };
                          setFormEnvironment(next);
                        }}
                        className="flex-1 text-sm"
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={editingReadOnly}
                        className="text-text-muted hover:text-destructive shrink-0"
                        onClick={() => setFormEnvironment(formEnvironment.filter((_, i) => i !== idx))}
                      >
                        {t("btn.delete")}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          {formType === "remote" && (
            <>
              <div>
                <label className="text-sm font-medium text-text-primary">{t("form.url")}</label>
                <div className="flex gap-2 mt-1">
                  <Input
                    value={formUrl}
                    onChange={(e) => setFormUrl(e.target.value)}
                    disabled={editingReadOnly}
                    placeholder="https://example.com/mcp"
                    className="flex-1 font-mono text-sm"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={editingReadOnly || testingUrl || !formUrl.trim()}
                    onClick={handleTestFormUrl}
                  >
                    {testingUrl ? t("btn.testing") : t("btn.test")}
                  </Button>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-text-primary">{t("form.headers")}</label>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={editingReadOnly}
                    onClick={() => setFormHeaders([...formHeaders, { key: "", value: "" }])}
                  >
                    {t("btn.add")}
                  </Button>
                </div>
                <div className="space-y-2">
                  {formHeaders.map((entry, idx) => (
                    <div key={entry.key || `header-${idx}`} className="flex gap-2 items-center">
                      <Input
                        placeholder={t("headerNamePlaceholder")}
                        value={entry.key}
                        disabled={editingReadOnly}
                        onChange={(e) => {
                          const next = [...formHeaders];
                          next[idx] = { ...next[idx], key: e.target.value };
                          setFormHeaders(next);
                        }}
                        className="flex-1 text-sm"
                      />
                      <Input
                        placeholder={t("headerValuePlaceholder")}
                        value={entry.value}
                        disabled={editingReadOnly}
                        onChange={(e) => {
                          const next = [...formHeaders];
                          next[idx] = { ...next[idx], value: e.target.value };
                          setFormHeaders(next);
                        }}
                        className="flex-1 text-sm"
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={editingReadOnly}
                        className="text-text-muted hover:text-destructive shrink-0"
                        onClick={() => setFormHeaders(formHeaders.filter((_, i) => i !== idx))}
                      >
                        {t("btn.delete")}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
              <Collapsible open={oauthExpanded} onOpenChange={editingReadOnly ? undefined : setOauthExpanded}>
                <div className="rounded-lg border border-border-light">
                  <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-text-primary hover:bg-surface-hover transition-colors">
                    {t("form.oauthConfig")}
                    <span className="text-xs text-text-muted">
                      {oauthExpanded ? t("form.oauthCollapse") : t("form.oauthExpand")}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="space-y-4 px-4 pb-4 border-t border-border-light pt-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-sm font-medium text-text-primary">{t("form.clientId")}</label>
                          <Input
                            value={formOauthClientId}
                            onChange={(e) => setFormOauthClientId(e.target.value)}
                            disabled={editingReadOnly}
                            placeholder={t("form.optional")}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium text-text-primary">{t("form.clientSecret")}</label>
                          <Input
                            type="password"
                            value={formOauthClientSecret}
                            onChange={(e) => setFormOauthClientSecret(e.target.value)}
                            disabled={editingReadOnly}
                            placeholder={t("form.optional")}
                            className="mt-1"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-sm font-medium text-text-primary">{t("form.scope")}</label>
                          <Input
                            value={formOauthScope}
                            onChange={(e) => setFormOauthScope(e.target.value)}
                            disabled={editingReadOnly}
                            placeholder={t("form.optional")}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium text-text-primary">{t("form.redirectUri")}</label>
                          <Input
                            value={formOauthRedirectUri}
                            onChange={(e) => setFormOauthRedirectUri(e.target.value)}
                            disabled={editingReadOnly}
                            placeholder={t("form.optional")}
                            className="mt-1"
                          />
                        </div>
                      </div>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            </>
          )}
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.timeout")}</label>
            <p className="text-xs text-text-muted mb-1.5">{t("form.timeoutHint")}</p>
            <Input
              type="number"
              value={formTimeout}
              onChange={(e) => setFormTimeout(e.target.value)}
              disabled={editingReadOnly}
              placeholder="5000"
              min={1}
              className="font-mono text-sm"
            />
          </div>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription", { name: deleteTarget ?? "" })}
        variant="destructive"
        onConfirm={() => deleteTarget && runDelete(deleteTarget)}
      />
    </div>
  );
}
