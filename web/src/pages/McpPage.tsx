import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { type Column, DataTable } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { mcpApi } from "@/src/api/sdk";
import type {
  McpInspectResult,
  McpLocalConfig,
  McpRemoteConfig,
  McpServerConfig,
  McpServerInfo,
  McpToolInfo,
} from "../types/config";

/** 键值对列表项类型 */
export type KeyValueEntry = { key: string; value: string };

/** 校验 MCP 服务器表单，返回错误消息或 null */
export function validateMcpForm(
  name: string,
  type: "local" | "remote",
  command: string,
  url: string,
  t: (key: string) => string,
): string | null {
  if (!name.trim()) return t("validation.nameRequired");
  if (/--/.test(name)) return t("validation.nameNoDoubleHyphen");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return t("validation.namePattern");
  }
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

/** 将用户输入的命令字符串按空格拆分为字符串数组（支持引号包裹的参数） */
export function parseCommandString(input: string): string[] {
  const tokens: string[] = [];
  const regex = /(?:[^\s"]+|"[^"]*")+/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
  while ((match = regex.exec(input)) !== null) {
    tokens.push(match[0].replace(/^"|"$/g, ""));
  }
  return tokens;
}

/** 将命令字符串数组转为用户可编辑的空格分隔字符串 */
export function commandToString(command: string[]): string {
  return command.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

/** 从 MCP 配置中构建列表摘要文本 */
export function buildMcpSummary(config: McpServerConfig, disabledLabel: string): string {
  if ("type" in config) {
    if (config.type === "local") return (config as McpLocalConfig).command[0] ?? "";
    if (config.type === "remote") return (config as McpRemoteConfig).url ?? "";
  }
  return disabledLabel;
}

/** 将表单数据组装为 McpServerConfig 对象 */
export function buildMcpPayload(
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

export function McpPage() {
  const { t } = useTranslation("mcp");
  // --- 列表数据 ---
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // --- 对话框控制 ---
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // --- 批量操作 ---
  const [selected, setSelected] = useState<McpServerInfo[]>([]);
  const [batchAction, setBatchAction] = useState<"enable" | "disable" | "delete" | null>(null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);

  // --- 表单字段（新建/编辑共用） ---
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState<"local" | "remote">("remote");
  const [formCommand, setFormCommand] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formEnvironment, setFormEnvironment] = useState<KeyValueEntry[]>([{ key: "", value: "" }]);
  const [formHeaders, setFormHeaders] = useState<KeyValueEntry[]>([{ key: "", value: "" }]);
  const [formTimeout, setFormTimeout] = useState("");
  const [formSaving, setFormSaving] = useState(false);

  // --- OAuth 折叠面板 ---
  const [oauthExpanded, setOauthExpanded] = useState(false);
  const [formOauthClientId, setFormOauthClientId] = useState("");
  const [formOauthClientSecret, setFormOauthClientSecret] = useState("");
  const [formOauthScope, setFormOauthScope] = useState("");
  const [formOauthRedirectUri, setFormOauthRedirectUri] = useState("");

  // --- 测试连接（表单内 URL 测试） ---
  const [testingUrl, setTestingUrl] = useState(false);

  // --- 检测（连通性 + 工具发现） ---
  const [inspectingServer, setInspectingServer] = useState<string | null>(null);
  const [toolsCache, setToolsCache] = useState<Record<string, McpToolInfo[]>>({});

  const loadServers = useCallback(async () => {
    setLoading(true);
    try {
      const { data: listData, error: listError } = await mcpApi.list();
      if (listError) throw listError;
      const data = (Array.isArray(listData)
        ? listData
        : (((listData as unknown as Record<string, unknown>)?.servers ??
            []) as McpServerInfo[])) as unknown as McpServerInfo[];
      setServers(data);
      // 预加载有 tools 的服务器缓存
      const serversWithTools = data.filter(
        (s) => (((s as unknown as Record<string, unknown>).toolsCount as number) ?? 0) > 0,
      );
      if (serversWithTools.length > 0) {
        Promise.all(
          serversWithTools.map(async (s) => {
            if (toolsCache[(s as unknown as Record<string, unknown>).name as string]) return;
            const { data: toolsData } = await mcpApi.listTools(
              (s as unknown as Record<string, unknown>).name as string,
            );
            if (toolsData) {
              const tools = (toolsData as unknown as Record<string, unknown>)?.tools;
              setToolsCache((prev) => ({
                ...prev,
                [(s as unknown as Record<string, unknown>).name as string]: Array.isArray(tools)
                  ? (tools as unknown as McpToolInfo[])
                  : [],
              }));
            }
          }),
        );
      }
    } catch (e) {
      console.error(t("toast.loadListFailed"), e);
      toast.error(t("toast.loadListFailedWith", { message: e instanceof Error ? e.message : t("toast.saveFailed") }));
    } finally {
      setLoading(false);
    }
  }, [t, toolsCache]);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const columns: Column<McpServerInfo>[] = [
    {
      key: "name",
      header: t("column.name"),
      sortable: true,
      filterable: true,
      render: (row) => <span className="font-mono text-sm text-text-bright">{row.name}</span>,
    },
    {
      key: "type",
      header: t("column.type"),
      filterable: true,
      render: (row) => {
        const isLocal = row.type === "local";
        const isRemote = row.type === "remote";
        return (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${
              isLocal
                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                : isRemote
                  ? "bg-cyan-subtle text-cyan dark:text-cyan"
                  : "bg-surface-2 text-text-muted"
            }`}
          >
            {isLocal ? "Local" : isRemote ? "Remote" : t("disabled")}
          </span>
        );
      },
    },
    {
      key: "enabled",
      header: t("column.status"),
      filterable: true,
      render: (row) => <StatusBadge status={row.enabled ? "enabled" : "disabled"} />,
    },
    {
      key: "summary",
      header: t("column.commandUrl"),
      render: (row) => (
        <span className="block max-w-[220px] truncate text-xs font-mono text-text-secondary" title={row.summary}>
          {row.summary || "—"}
        </span>
      ),
    },
    {
      key: "toolsCount",
      header: t("column.tools"),
      render: (row) => {
        const count = row.toolsCount ?? 0;
        return (
          <span
            className={`inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full text-xs font-medium ${
              count > 0 ? "bg-brand-subtle text-brand dark:text-brand-light" : "bg-surface-2 text-text-muted"
            }`}
          >
            {count > 0 ? count : "—"}
          </span>
        );
      },
    },
  ];

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
    const { data: detail, error: detailError } = await mcpApi.get(server.name);
    if (detailError) {
      console.error(t("toast.loadDetailFailed"), detailError);
      toast.error(t("toast.loadDetailFailed"));
    } else {
      const config = ((detail as Record<string, unknown>)?.config ?? detail) as McpServerConfig;
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
      console.error(t("toast.saveFailed"), err);
      toast.error(err);
      return;
    }
    setFormSaving(true);
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
    if (editingServer) {
      const { error } = await mcpApi.set(formName, payload as unknown as Record<string, unknown>);
      if (error) {
        console.error(t("toast.saveFailed"), error);
        toast.error(t("toast.saveFailedWith", { message: error.message }));
        setFormSaving(false);
        return;
      }
      toast.success(t("toast.serverUpdated"));
    } else {
      const { error } = await mcpApi.create(formName, payload as unknown as Record<string, unknown>);
      if (error) {
        console.error(t("toast.saveFailed"), error);
        toast.error(t("toast.saveFailedWith", { message: error.message }));
        setFormSaving(false);
        return;
      }
      toast.success(t("toast.serverCreated"));
    }
    setFormSaving(false);
    setDialogOpen(false);
    loadServers();
  };

  const handleToggle = async (server: McpServerInfo) => {
    if (server.enabled) {
      const { error } = await mcpApi.disable(server.name);
      if (error) {
        console.error(t("toast.operationFailed"), error);
        toast.error(t("toast.operationFailedWith", { message: error.message }));
        return;
      }
      toast.success(t("toast.disabled", { name: server.name }));
    } else {
      const { error } = await mcpApi.enable(server.name);
      if (error) {
        console.error(t("toast.operationFailed"), error);
        toast.error(t("toast.operationFailedWith", { message: error.message }));
        return;
      }
      toast.success(t("toast.enabled", { name: server.name }));
    }
    loadServers();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { error } = await mcpApi.delete(deleteTarget);
    if (error) {
      console.error(t("toast.deleteFailed"), error);
      toast.error(t("toast.deleteFailedWith", { message: error.message }));
      return;
    }
    toast.success(t("toast.serverDeleted"));
    setConfirmOpen(false);
    loadServers();
  };

  const handleBatchAction = (action: "enable" | "disable" | "delete") => {
    setBatchAction(action);
    setBatchConfirmOpen(true);
  };

  const confirmBatchAction = async () => {
    if (batchAction === "delete") {
      await Promise.all(selected.map((s) => mcpApi.delete(s.name)));
      toast.success(t("toast.batchDeleted", { count: selected.length }));
    } else if (batchAction === "enable") {
      await Promise.all(selected.filter((s) => !s.enabled).map((s) => mcpApi.enable(s.name)));
      toast.success(t("toast.batchEnabled", { count: selected.length }));
    } else {
      await Promise.all(selected.filter((s) => s.enabled).map((s) => mcpApi.disable(s.name)));
      toast.success(t("toast.batchDisabled", { count: selected.length }));
    }
    setBatchConfirmOpen(false);
    setSelected([]);
    loadServers();
  };

  const handleInspect = async (server: McpServerInfo) => {
    setInspectingServer(server.name);
    const { data: result, error } = (await mcpApi.inspect(server.name)) as unknown as {
      data: McpInspectResult;
      error: { message: string } | null;
    };
    if (error || !result) {
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
    // 刷新列表获取 toolsCount
    loadServers();
    // 缓存 tools
    setToolsCache((prev) => ({
      ...prev,
      [server.name]: result.tools.map((toolItem) => ({
        id: `${server.name}:${toolItem.name}`,
        toolName: toolItem.name,
        description: toolItem.description ?? null,
        inputSchema: toolItem.inputSchema ? JSON.stringify(toolItem.inputSchema) : null,
        inspectedAt: Date.now(),
      })),
    }));
    setInspectingServer(null);
  };

  const handleTestFormUrl = async () => {
    if (!formUrl.trim()) return;
    setTestingUrl(true);
    const headersObj =
      formHeaders.filter((h) => h.key.trim()).length > 0
        ? Object.fromEntries(formHeaders.filter((h) => h.key.trim()).map((h) => [h.key, h.value]))
        : undefined;
    const timeoutNum = formTimeout ? parseInt(formTimeout, 10) : undefined;
    const { data: result, error } = await mcpApi.testUrl(formUrl);
    if (error) {
      console.error(t("toast.testFailed"), error);
      toast.error(t("toast.testFailedWith", { message: error.message }));
    } else {
      const d = result as Record<string, unknown>;
      if (d?.reachable && d?.protocol) {
        const toolsInfo = d.toolsCount != null ? `，${d.toolsCount} ${t("column.tools").toLowerCase()}` : "";
        toast.success(
          t("toast.testSuccess", {
            serverName: (d.serverName as string) ?? "",
            serverVersion: (d.serverVersion as string) ?? "",
            toolsInfo,
          }),
        );
      } else if (d?.reachable) {
        toast.warning(t("toast.testReachable", { message: (d.message as string) ?? "" }));
      } else {
        toast.error(t("toast.testFailed", { message: (d?.message as string) ?? t("toast.saveFailed") }));
      }
    }
    setTestingUrl(false);
  };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="rounded-md border">
          <Skeleton className="h-10 w-full rounded-t-md" />
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-12 w-full rounded-none border-t" />
          ))}
        </div>
      </div>
    );
  }

  const batchActionLabel =
    batchAction === "delete" ? t("btn.delete") : batchAction === "enable" ? t("btn.enable") : t("btn.disable");

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-bright">{t("title")}</h2>
          <p className="text-sm text-text-muted mt-0.5">{t("subtitle")}</p>
        </div>
        <Button onClick={handleOpenCreate}>{t("btn.newServer")}</Button>
      </div>
      <DataTable<McpServerInfo>
        columns={columns}
        data={servers}
        searchable
        searchPlaceholder={t("search")}
        selectable
        onSelectionChange={setSelected}
        rowKey={(row) => row.name}
        emptyMessage={t("empty")}
        expandableRow={(row) => {
          const tools = toolsCache[row.name];
          if (!tools || tools.length === 0) {
            return <div className="py-4 text-center text-sm text-text-muted">{t("tools.noTools")}</div>;
          }
          return (
            <div className="grid gap-2 max-h-72 overflow-y-auto">
              {tools.map((tool) => (
                <div
                  key={tool.id}
                  className="group rounded-lg border border-border-light bg-surface-1 px-3 py-2.5 transition-colors hover:border-border"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium text-text-bright">{tool.toolName}</span>
                      </div>
                      {tool.description && (
                        <p className="mt-0.5 text-xs text-text-secondary line-clamp-2">{tool.description}</p>
                      )}
                    </div>
                    {tool.inputSchema ? (
                      <details className="shrink-0">
                        <summary className="text-xs text-text-muted cursor-pointer hover:text-text-primary transition-colors">
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
          );
        }}
        actions={(row) => (
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={inspectingServer === row.name}
              onClick={() => handleInspect(row)}
            >
              {inspectingServer === row.name ? t("btn.inspecting") : t("btn.inspect")}
            </Button>
            <Button size="xs" variant="outline" onClick={() => handleToggle(row)}>
              {row.enabled ? t("btn.disable") : t("btn.enable")}
            </Button>
            <Button size="xs" variant="outline" onClick={() => handleOpenEdit(row)}>
              {t("btn.edit")}
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onClick={() => {
                setDeleteTarget(row.name);
                setConfirmOpen(true);
              }}
            >
              {t("btn.delete")}
            </Button>
          </div>
        )}
      />
      {selected.length > 0 && (
        <BatchActionBar
          selectedCount={selected.length}
          onClear={() => setSelected([])}
          actions={[
            { label: t("btn.batchEnable"), onClick: () => handleBatchAction("enable") },
            { label: t("btn.batchDisable"), onClick: () => handleBatchAction("disable") },
            { label: t("btn.batchDelete"), variant: "destructive", onClick: () => handleBatchAction("delete") },
          ]}
        />
      )}
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingServer ? t("dialog.editTitle") : t("dialog.createTitle")}
        onSubmit={handleSave}
        loading={formSaving}
        width="sm:max-w-2xl"
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.name")}</label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              disabled={!!editingServer}
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
              disabled={!!editingServer}
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
                    placeholder="https://example.com/mcp"
                    className="flex-1 font-mono text-sm"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={testingUrl || !formUrl.trim()}
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
                        className="text-text-muted hover:text-destructive shrink-0"
                        onClick={() => setFormHeaders(formHeaders.filter((_, i) => i !== idx))}
                      >
                        {t("btn.delete")}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
              <Collapsible open={oauthExpanded} onOpenChange={setOauthExpanded}>
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
                            placeholder={t("form.optional")}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium text-text-primary">{t("form.redirectUri")}</label>
                          <Input
                            value={formOauthRedirectUri}
                            onChange={(e) => setFormOauthRedirectUri(e.target.value)}
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
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={batchConfirmOpen}
        onOpenChange={setBatchConfirmOpen}
        title={t("confirm.batchTitle", { action: batchActionLabel })}
        description={t("confirm.batchDescription", {
          action: batchActionLabel,
          count: selected.length,
          hint: batchAction === "delete" ? t("confirm.batchDeleteHint") : "",
        })}
        variant={batchAction === "delete" ? "destructive" : "default"}
        onConfirm={confirmBatchAction}
      />
    </div>
  );
}
