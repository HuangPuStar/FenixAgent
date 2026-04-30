import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { DataTable, type Column } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import {
  apiListMcpServers, apiGetMcpServer, apiCreateMcpServer,
  apiUpdateMcpServer, apiDeleteMcpServer, apiEnableMcpServer, apiDisableMcpServer,
  apiTestMcpServer, apiTestMcpUrl, apiInspectMcpServer, apiListMcpTools,
} from "../api/client";
import type { McpServerInfo, McpServerConfig, McpLocalConfig, McpRemoteConfig, McpToolInfo } from "../types/config";

/** 键值对列表项类型 */
export type KeyValueEntry = { key: string; value: string };

/** 校验 MCP 服务器表单，返回错误消息或 null */
export function validateMcpForm(
  name: string,
  type: "local" | "remote",
  command: string,
  url: string,
): string | null {
  if (!name.trim()) return "名称不能为空";
  if (/--/.test(name)) return "名称不能包含连续连字符";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return "名称只能包含小写字母、数字和连字符，且不能以连字符开头/结尾";
  }
  if (name.length > 64) return "名称长度不能超过 64 个字符";
  if (type === "local") {
    if (!command.trim()) return "命令不能为空";
    const parts = parseCommandString(command);
    if (parts.length === 0) return "命令格式不正确";
  }
  if (type === "remote") {
    if (!url.trim()) return "URL 不能为空";
    try { new URL(url); } catch { return "URL 格式不正确"; }
  }
  return null;
}

/** 将用户输入的命令字符串按空格拆分为字符串数组（支持引号包裹的参数） */
export function parseCommandString(input: string): string[] {
  const tokens: string[] = [];
  const regex = /(?:[^\s"]+|"[^"]*")+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    tokens.push(match[0].replace(/^"|"$/g, ""));
  }
  return tokens;
}

/** 将命令字符串数组转为用户可编辑的空格分隔字符串 */
export function commandToString(command: string[]): string {
  return command
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
}

/** 从 MCP 配置中构建列表摘要文本 */
export function buildMcpSummary(config: McpServerConfig): string {
  if ("type" in config) {
    if (config.type === "local") return (config as McpLocalConfig).command[0] ?? "";
    if (config.type === "remote") return (config as McpRemoteConfig).url ?? "";
  }
  return "已禁用";
  return "";
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
      const data = await apiListMcpServers();
      setServers(data);
      // 预加载有 tools 的服务器缓存
      const serversWithTools = data.filter((s) => (s.toolsCount ?? 0) > 0);
      if (serversWithTools.length > 0) {
        Promise.all(
          serversWithTools.map(async (s) => {
            if (toolsCache[s.name]) return;
            try {
              const result = await apiListMcpTools(s.name);
              setToolsCache((prev) => ({ ...prev, [s.name]: result.tools }));
            } catch {
              // 静默失败
            }
          }),
        );
      }
    } catch (e) {
      toast.error("加载 MCP 服务器列表失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadServers(); }, [loadServers]);

  const columns: Column<McpServerInfo>[] = [
    { key: "name", header: "名称", sortable: true, filterable: true },
    {
      key: "type",
      header: "类型",
      filterable: true,
      render: (row) => (
        <StatusBadge status={row.type === "local" ? "local" : row.type === "remote" ? "remote" : "disabled"} />
      ),
    },
    {
      key: "enabled",
      header: "状态",
      filterable: true,
      render: (row) => <StatusBadge status={row.enabled ? "enabled" : "disabled"} />,
    },
    { key: "summary", header: "简要描述" },
    {
      key: "timeout",
      header: "超时(ms)",
      render: (row) => row.timeout != null ? `${row.timeout}ms` : "默认",
    },
    {
      key: "toolsCount",
      header: "Tools",
      render: (row) => {
        const count = row.toolsCount ?? 0;
        return count > 0 ? (
          <span className="text-xs bg-indigo-100 text-indigo-800 px-1.5 py-0.5 rounded">{count} 个工具</span>
        ) : (
          <span className="text-xs text-muted-foreground">未检测</span>
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
    try {
      const detail = await apiGetMcpServer(server.name);
      const config = detail.config;
      if ("type" in config && config.type === "local") {
        setFormType("local");
        setFormCommand(commandToString(config.command));
        setFormEnvironment(
          config.environment
            ? Object.entries(config.environment).map(([key, value]) => ({ key, value }))
            : [{ key: "", value: "" }]
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
            ? Object.entries(config.headers).map(([key, value]) => ({ key, value }))
            : [{ key: "", value: "" }]
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
    } catch {
      toast.error("加载服务器详情失败");
    }
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const err = validateMcpForm(formName, formType, formCommand, formUrl);
    if (err) { toast.error(err); return; }
    setFormSaving(true);
    try {
      const payload = buildMcpPayload(
        formType, formCommand, formUrl, formEnvironment, formHeaders,
        formOauthClientId, formOauthClientSecret, formOauthScope, formOauthRedirectUri,
        formTimeout,
      );
      if (editingServer) {
        await apiUpdateMcpServer(formName, payload);
        toast.success("服务器已更新");
      } else {
        await apiCreateMcpServer(formName, payload);
        toast.success("服务器已创建");
      }
      setDialogOpen(false);
      loadServers();
    } catch (e) {
      toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setFormSaving(false);
    }
  };

  const handleToggle = async (server: McpServerInfo) => {
    try {
      if (server.enabled) {
        await apiDisableMcpServer(server.name);
        toast.success(`已禁用 "${server.name}"`);
      } else {
        await apiEnableMcpServer(server.name);
        toast.success(`已启用 "${server.name}"`);
      }
      loadServers();
    } catch (e) {
      toast.error("操作失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiDeleteMcpServer(deleteTarget);
      toast.success("服务器已删除");
      setConfirmOpen(false);
      loadServers();
    } catch (e) {
      toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleBatchAction = (action: "enable" | "disable" | "delete") => {
    setBatchAction(action);
    setBatchConfirmOpen(true);
  };

  const confirmBatchAction = async () => {
    try {
      if (batchAction === "delete") {
        await Promise.all(selected.map((s) => apiDeleteMcpServer(s.name)));
        toast.success(`已删除 ${selected.length} 个服务器`);
      } else if (batchAction === "enable") {
        await Promise.all(selected.filter((s) => !s.enabled).map((s) => apiEnableMcpServer(s.name)));
        toast.success(`已启用 ${selected.length} 个服务器`);
      } else {
        await Promise.all(selected.filter((s) => s.enabled).map((s) => apiDisableMcpServer(s.name)));
        toast.success(`已禁用 ${selected.length} 个服务器`);
      }
      setBatchConfirmOpen(false);
      setSelected([]);
      loadServers();
    } catch (e) {
      toast.error("批量操作失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleInspect = async (server: McpServerInfo) => {
    setInspectingServer(server.name);
    try {
      const result = await apiInspectMcpServer(server.name);
      toast.success(`${server.name} 连接成功：${result.serverInfo.name ?? ""} v${result.serverInfo.version ?? ""}，发现 ${result.tools.length} 个工具`);
      // 刷新列表获取 toolsCount
      loadServers();
      // 缓存 tools
      setToolsCache((prev) => ({ ...prev, [server.name]: result.tools.map((t) => ({
        id: `${server.name}:${t.name}`,
        toolName: t.name,
        description: t.description ?? null,
        inputSchema: t.inputSchema ? JSON.stringify(t.inputSchema) : null,
        inspectedAt: Date.now(),
      })) }));
    } catch (e) {
      toast.error(`检测失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setInspectingServer(null);
    }
  };

  const loadToolsIfNeeded = async (serverName: string) => {
    if (toolsCache[serverName]) return;
    try {
      const result = await apiListMcpTools(serverName);
      setToolsCache((prev) => ({ ...prev, [serverName]: result.tools }));
    } catch {
      // 静默失败，展开区域会显示空
    }
  };

  const handleTestFormUrl = async () => {
    if (!formUrl.trim()) return;
    setTestingUrl(true);
    try {
      const headersObj = formHeaders.filter((h) => h.key.trim()).length > 0
        ? Object.fromEntries(formHeaders.filter((h) => h.key.trim()).map((h) => [h.key, h.value]))
        : undefined;
      const timeoutNum = formTimeout ? parseInt(formTimeout, 10) : undefined;
      const result = await apiTestMcpUrl(formUrl, headersObj, timeoutNum);
      if (result.reachable && result.protocol) {
        const toolsInfo = result.toolsCount != null ? `，${result.toolsCount} 个工具` : "";
        toast.success(`连接成功：${result.serverName ?? ""} v${result.serverVersion ?? ""}${toolsInfo}`);
      } else if (result.reachable) {
        toast.warning(`可达但非 MCP 协议：${result.message ?? ""}`);
      } else {
        toast.error(`连接失败：${result.message ?? "未知错误"}`);
      }
    } catch (e) {
      toast.error(`测试失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setTestingUrl(false);
    }
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
            <Skeleton key={i} className="h-12 w-full rounded-none border-t" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">MCP 服务器管理</h2>
        <Button onClick={handleOpenCreate}>新建 MCP 服务器</Button>
      </div>
      <DataTable<McpServerInfo>
        columns={columns}
        data={servers}
        searchable
        searchPlaceholder="搜索 MCP 服务器..."
        selectable
        onSelectionChange={setSelected}
        rowKey={(row) => row.name}
        expandableRow={(row) => {
          const tools = toolsCache[row.name];
          if (!tools || tools.length === 0) {
            return (
              <div className="text-sm text-muted-foreground py-1">
                暂无已发现的工具，点击"检测"按钮发现工具
              </div>
            );
          }
          return (
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/30">
                  <tr className="border-b">
                    <th className="px-2 py-1 text-left text-muted-foreground">工具名称</th>
                    <th className="px-2 py-1 text-left text-muted-foreground">描述</th>
                    <th className="px-2 py-1 text-left text-muted-foreground">输入参数</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map((tool) => (
                    <tr key={tool.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-2 py-1 font-mono text-xs text-indigo-700 whitespace-nowrap">{tool.toolName}</td>
                      <td className="px-2 py-1 text-xs max-w-xs truncate" title={tool.description ?? undefined}>{tool.description || "—"}</td>
                      <td className="px-2 py-1">
                        {tool.inputSchema ? (
                          <details>
                            <summary className="text-xs text-muted-foreground cursor-pointer">查看参数</summary>
                            <pre className="text-xs mt-1 p-2 bg-muted rounded overflow-x-auto max-h-40">
                              {(() => {
                                try { return JSON.stringify(JSON.parse(tool.inputSchema), null, 2); }
                                catch { return tool.inputSchema; }
                              })()}
                            </pre>
                          </details>
                        ) : (
                          <span className="text-xs text-muted-foreground">无参数</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
        actions={(row) => (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={inspectingServer === row.name} onClick={() => handleInspect(row)}>
              {inspectingServer === row.name ? "检测中..." : "检测"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleToggle(row)}>
              {row.enabled ? "禁用" : "启用"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
            <Button size="sm" variant="destructive"
              onClick={() => { setDeleteTarget(row.name); setConfirmOpen(true); }}>删除</Button>
          </div>
        )}
      />
      {selected.length > 0 && (
        <BatchActionBar
          selectedCount={selected.length}
          onClear={() => setSelected([])}
          actions={[
            { label: "批量启用", onClick: () => handleBatchAction("enable") },
            { label: "批量禁用", onClick: () => handleBatchAction("disable") },
            { label: "批量删除", variant: "destructive", onClick: () => handleBatchAction("delete") },
          ]}
        />
      )}
      <FormDialog open={dialogOpen} onOpenChange={setDialogOpen}
        title={editingServer ? "编辑 MCP 服务器" : "新建 MCP 服务器"}
        onSubmit={handleSave} loading={formSaving} width="sm:max-w-2xl">
        <div className="space-y-4">
          <div>
            <Label>名称</Label>
            <Input value={formName} onChange={(e) => setFormName(e.target.value)}
              disabled={!!editingServer} placeholder="例如 my-mcp-server" />
          </div>
          <div>
            <Label>类型</Label>
            <Select value={formType} onValueChange={(v) => setFormType(v as "local" | "remote")}
              disabled={!!editingServer}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local（命令行启动）</SelectItem>
                <SelectItem value="remote">Remote（URL 连接）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {formType === "local" && (
            <>
              <div>
                <Label>命令（空格分隔，含引号参数用双引号包裹）</Label>
                <Input value={formCommand} onChange={(e) => setFormCommand(e.target.value)}
                  placeholder="npx @anthropic/mcp-server-xxx --arg1 val1" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>环境变量</Label>
                  <Button type="button" size="sm" variant="outline"
                    onClick={() => setFormEnvironment([...formEnvironment, { key: "", value: "" }])}>
                    添加
                  </Button>
                </div>
                {formEnvironment.map((entry, idx) => (
                  <div key={idx} className="flex gap-2 mb-2 items-center">
                    <Input placeholder="KEY" value={entry.key}
                      onChange={(e) => {
                        const next = [...formEnvironment];
                        next[idx] = { ...next[idx], key: e.target.value };
                        setFormEnvironment(next);
                      }} className="flex-1" />
                    <Input placeholder="VALUE" value={entry.value}
                      onChange={(e) => {
                        const next = [...formEnvironment];
                        next[idx] = { ...next[idx], value: e.target.value };
                        setFormEnvironment(next);
                      }} className="flex-1" />
                    <Button type="button" size="sm" variant="ghost"
                      onClick={() => setFormEnvironment(formEnvironment.filter((_, i) => i !== idx))}>
                      删除
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
          {formType === "remote" && (
            <>
              <div>
                <Label>URL</Label>
                <div className="flex gap-2">
                  <Input value={formUrl} onChange={(e) => setFormUrl(e.target.value)}
                    placeholder="https://example.com/mcp" className="flex-1" />
                  <Button type="button" size="sm" variant="outline" disabled={testingUrl || !formUrl.trim()}
                    onClick={handleTestFormUrl}>
                    {testingUrl ? "测试中..." : "测试连接"}
                  </Button>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>请求头</Label>
                  <Button type="button" size="sm" variant="outline"
                    onClick={() => setFormHeaders([...formHeaders, { key: "", value: "" }])}>
                    添加
                  </Button>
                </div>
                {formHeaders.map((entry, idx) => (
                  <div key={idx} className="flex gap-2 mb-2 items-center">
                    <Input placeholder="Header Name" value={entry.key}
                      onChange={(e) => {
                        const next = [...formHeaders];
                        next[idx] = { ...next[idx], key: e.target.value };
                        setFormHeaders(next);
                      }} className="flex-1" />
                    <Input placeholder="Header Value" value={entry.value}
                      onChange={(e) => {
                        const next = [...formHeaders];
                        next[idx] = { ...next[idx], value: e.target.value };
                        setFormHeaders(next);
                      }} className="flex-1" />
                    <Button type="button" size="sm" variant="ghost"
                      onClick={() => setFormHeaders(formHeaders.filter((_, i) => i !== idx))}>
                      删除
                    </Button>
                  </div>
                ))}
              </div>
              <Collapsible open={oauthExpanded} onOpenChange={setOauthExpanded}>
                <div className="rounded-lg border">
                  <CollapsibleTrigger className="flex w-full items-center justify-between p-4 text-sm font-medium hover:bg-muted/50 transition-colors">
                    OAuth 配置（可选）
                    <span className="text-xs text-muted-foreground">{oauthExpanded ? "收起" : "展开"}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="space-y-4 px-4 pb-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Client ID</Label>
                          <Input value={formOauthClientId}
                            onChange={(e) => setFormOauthClientId(e.target.value)} placeholder="可选" />
                        </div>
                        <div>
                          <Label>Client Secret</Label>
                          <Input type="password" value={formOauthClientSecret}
                            onChange={(e) => setFormOauthClientSecret(e.target.value)} placeholder="可选" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Scope</Label>
                          <Input value={formOauthScope}
                            onChange={(e) => setFormOauthScope(e.target.value)} placeholder="可选" />
                        </div>
                        <div>
                          <Label>Redirect URI</Label>
                          <Input value={formOauthRedirectUri}
                            onChange={(e) => setFormOauthRedirectUri(e.target.value)} placeholder="可选" />
                        </div>
                      </div>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            </>
          )}
          <div>
            <Label>超时时间（毫秒，留空使用默认值）</Label>
            <Input type="number" value={formTimeout}
              onChange={(e) => setFormTimeout(e.target.value)}
              placeholder="例如 5000" min={1} />
          </div>
        </div>
      </FormDialog>
      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
        title="确认删除" description={`此操作不可逆。确定要删除 MCP 服务器 "${deleteTarget}" 吗？`}
        variant="destructive" onConfirm={confirmDelete} />
      <ConfirmDialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}
        title={`批量${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}确认`}
        description={`确定要${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}选中的 ${selected.length} 个服务器吗？${batchAction === "delete" ? "此操作不可逆。" : ""}`}
        variant={batchAction === "delete" ? "destructive" : "default"}
        onConfirm={confirmBatchAction} />
    </div>
  );
}
