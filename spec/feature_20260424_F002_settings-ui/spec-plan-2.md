# Settings UI 执行计划（二）：配置模块页面

**目标:** 实现 Providers、Models、Agents、Skills 四个配置模块的完整前端管理页面，对接后端 API，提供 CRUD 交互体验。

**技术栈:** React 19 + TypeScript + shadcn/ui + sonner + react-markdown + bun:test

**设计文档:** spec/feature_20260424_F002_settings-ui/spec-design.md

## 改动总览

本计划实现 4 个配置模块的前端管理页面。Task 0 为轻量环境验证，确认 spec-plan-1.md 产出已就绪。Task 6-9 各实现一个模块页面（Providers/Models/Agents/Skills），每个页面为独立文件，均使用 spec-plan-1.md 中构建的共享组件（DataTable、ConfirmDialog、FormDialog 等）和 API Client 函数。Task 6-9 之间无依赖关系，可并行开发，但全部依赖 spec-plan-1.md 的 Task 1-5 产出。Task 6（Providers）含测试连接特殊交互；Task 7（Models）为配置卡片+只读列表，含手动输入模型 ID 支持；Task 8（Agents）含内置 Agent 保护逻辑；Task 9（Skills）含 Markdown 编辑器。

---

### Task 0: 环境准备（轻量验证）

**背景:**
spec-plan-1.md 的 Task 0 已完成完整环境验证，本文件仅需确认前置计划的产出已就绪。

**执行步骤:**

- [ ] 确认共享组件已就绪
  - 运行: `ls /Users/konghayao/code/pazhou/remote-control-server/web/components/config/index.ts`
  - 预期: 文件存在

**检查步骤:**

- [ ] API Client 包含配置函数
  - `grep "apiListProviders" /Users/konghayao/code/pazhou/remote-control-server/web/src/api/client.ts`
  - 预期: 匹配到函数定义

---

### Task 6: 服务商（Providers）页面

**背景:**
实现 Providers 配置管理页面，提供完整的 CRUD 交互：列表展示（含搜索、排序）、新建/编辑弹窗、API Key 密码框、测试连接流程、批量删除。Providers 是 AI 服务商的配置入口，用户通过此页面管理 OpenAI、Anthropic 等服务商的 API Key 和连接信息。
**修改原因:** 当前无 Providers 前端页面，后端 API（Task 2）已就绪。
**上下游影响:** 本页面被 Task 5 的路由引用，依赖 Task 2 的 API Client 函数和 Task 3-4 的共享组件。

**涉及文件:**

- 新建: `web/src/pages/ProvidersPage.tsx`

**执行步骤:**

- [ ] 创建 ProvidersPage 组件
  - 新建文件: `web/src/pages/ProvidersPage.tsx`
  - 导出命名导出: `export function ProvidersPage()`
  - 整体结构:

    ```typescript
    import { useState, useCallback, useEffect } from "react";
    import { toast } from "sonner";
    import { DataTable, type Column } from "@/components/config/DataTable";
    import { FormDialog } from "@/components/config/FormDialog";
    import { ConfirmDialog } from "@/components/config/ConfirmDialog";
    import { BatchActionBar } from "@/components/config/BatchActionBar";
    import { StatusBadge } from "@/components/config/StatusBadge";
    import { Button } from "@/components/ui/button";
    import { Input } from "@/components/ui/input";
    import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
    import {
      apiListProviders, apiSetProvider, apiTestProvider, apiDeleteProvider,
    } from "../api/client";
    import type { ProviderInfo } from "../types/config";
    ```

- [ ] 实现页面状态管理
  - 位置: ProvidersPage 函数内
  - 状态:

    ```typescript
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingProvider, setEditingProvider] = useState<ProviderInfo | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
    const [selected, setSelected] = useState<ProviderInfo[]>([]);
    const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
    const [testResult, setTestResult] = useState<{ name: string; models: string[] } | null>(null);
    const [testing, setTesting] = useState<string | null>(null);
    // 表单字段
    const [formName, setFormName] = useState("");
    const [formApiKey, setFormApiKey] = useState("");
    const [formBaseURL, setFormBaseURL] = useState("");
    const [formTimeout, setFormTimeout] = useState("");
    const [formSaving, setFormSaving] = useState(false);
    ```

- [ ] 实现数据加载
  - 位置: ProvidersPage 函数内
  - `useEffect` 初始化加载:

    ```typescript
    const loadProviders = useCallback(async () => {
      setLoading(true);
      try {
        const data = await apiListProviders();
        setProviders(data);
      } catch (e) {
        toast.error("加载服务商列表失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { loadProviders(); }, [loadProviders]);
    ```

- [ ] 实现 DataTable 列配置
  - 位置: ProvidersPage 函数内，loadProviders 之后
  - 列定义:

    ```typescript
    const columns: Column<ProviderInfo>[] = [
      { key: "name", header: "名称", sortable: true, filterable: true },
      { key: "keyHint", header: "API Key", render: (row) => row.keyHint || "—" },
      { key: "baseURL", header: "Base URL" },
      {
        key: "configured",
        header: "状态",
        sortable: false,
        filterable: true,
        render: (row) => <StatusBadge status={row.configured ? "configured" : "unconfigured"} />,
      },
    ];
    ```

- [ ] 实现新建/编辑弹窗
  - 位置: ProvidersPage JSX 返回值内
  - 新建按钮: `<Button onClick={handleOpenCreate}>新建服务商</Button>`
  - handleOpenCreate:

    ```typescript
    const handleOpenCreate = () => {
      setEditingProvider(null);
      setFormName(""); setFormApiKey(""); setFormBaseURL(""); setFormTimeout("");
      setDialogOpen(true);
    };
    ```

  - handleOpenEdit:

    ```typescript
    const handleOpenEdit = (provider: ProviderInfo) => {
      setEditingProvider(provider);
      setFormName(provider.name); setFormApiKey(""); setFormBaseURL(""); setFormTimeout("");
      setDialogOpen(true);
    };
    ```

  - handleSave:

    ```typescript
    const handleSave = async () => {
      if (!formName.trim()) { toast.error("名称不能为空"); return; }
      if (!editingProvider && (formName.length < 1 || formName.length > 64)) {
        toast.error("名称长度须在 1-64 字符之间"); return;
      }
      setFormSaving(true);
      try {
        const data: Record<string, unknown> = {};
        if (formApiKey) data.apiKey = formApiKey;
        if (formBaseURL) data.baseURL = formBaseURL;
        if (formTimeout) data.timeout = parseInt(formTimeout);
        await apiSetProvider(formName, data);
        toast.success(editingProvider ? "服务商已更新" : "服务商已创建");
        setDialogOpen(false);
        loadProviders();
      } catch (e) {
        toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setFormSaving(false);
      }
    };
    ```

  - 表单弹窗 JSX:

    ```tsx
    <FormDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      title={editingProvider ? "编辑服务商" : "新建服务商"}
      onSubmit={handleSave}
      loading={formSaving}
    >
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium">名称</label>
          <Input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={!!editingProvider}
            placeholder="例如 openai"
          />
        </div>
        <div>
          <label className="text-sm font-medium">API Key</label>
          <div className="relative">
            <Input
              type="password"
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
              placeholder={editingProvider ? "留空表示不修改" : "输入 API Key"}
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium">Base URL</label>
          <Input value={formBaseURL} onChange={(e) => setFormBaseURL(e.target.value)} placeholder="可选，默认使用服务商 URL" />
        </div>
        <div>
          <label className="text-sm font-medium">Timeout (ms)</label>
          <Input type="number" value={formTimeout} onChange={(e) => setFormTimeout(e.target.value)} placeholder="可选" />
        </div>
      </div>
    </FormDialog>
    ```

- [ ] 实现测试连接流程
  - 位置: ProvidersPage 函数内
  - handleTest:

    ```typescript
    const handleTest = async (name: string) => {
      setTesting(name);
      try {
        const result = await apiTestProvider(name);
        setTestResult({ name, models: result.models });
      } catch (e) {
        toast.error("测试失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setTesting(null);
      }
    };
    ```

  - 测试结果 Dialog JSX:

    ```tsx
    <Dialog open={!!testResult} onOpenChange={() => setTestResult(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>连接测试成功 — {testResult?.name}</DialogTitle>
          <DialogDescription>发现 {testResult?.models.length} 个可用模型</DialogDescription>
        </DialogHeader>
        <div className="max-h-64 overflow-y-auto space-y-1">
          {testResult?.models.map((m) => (
            <div key={m} className="text-sm py-1 px-2 rounded bg-muted">{m}</div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
    ```

- [ ] 实现删除和批量删除
  - handleDelete:

    ```typescript
    const handleDelete = (name: string) => { setDeleteTarget(name); setConfirmOpen(true); };
    const confirmDelete = async () => {
      if (!deleteTarget) return;
      try {
        await apiDeleteProvider(deleteTarget);
        toast.success("服务商已删除");
        setConfirmOpen(false);
        loadProviders();
      } catch (e) {
        toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```

  - 批量删除:

    ```typescript
    const handleBatchDelete = () => { setBatchConfirmOpen(true); };
    const confirmBatchDelete = async () => {
      try {
        await Promise.all(selected.map((p) => apiDeleteProvider(p.name)));
        toast.success(`已删除 ${selected.length} 个服务商`);
        setBatchConfirmOpen(false);
        setSelected([]);
        loadProviders();
      } catch (e) {
        toast.error("批量删除失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```

- [ ] 组装页面 JSX
  - 位置: ProvidersPage 函数 return 语句
  - 结构:

    ```tsx
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">服务商管理</h2>
          <Button onClick={handleOpenCreate}>新建服务商</Button>
        </div>
        <DataTable<ProviderInfo>
          columns={columns}
          data={providers}
          searchable
          searchPlaceholder="搜索服务商..."
          selectable
          onSelectionChange={setSelected}
          actions={(row) => (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => handleTest(row.name)} disabled={testing === row.name}>
                {testing === row.name ? "测试中..." : "测试连接"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
              <Button size="sm" variant="destructive" onClick={() => handleDelete(row.name)}>删除</Button>
            </div>
          )}
        />
        {selected.length > 0 && (
          <BatchActionBar
            selectedCount={selected.length}
            onClear={() => setSelected([])}
            actions={[{ label: "批量删除", variant: "destructive", onClick: handleBatchDelete }]}
          />
        )}
        {/* 弹窗组件 */}
        <FormDialog ... />
        <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title="确认删除" description={`确定要删除服务商 "${deleteTarget}" 吗？`} variant="destructive" onConfirm={confirmDelete} />
        <ConfirmDialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen} title="批量删除确认" description={`确定要删除选中的 ${selected.length} 个服务商吗？`} variant="destructive" onConfirm={confirmBatchDelete} />
        {/* 测试结果 Dialog */}
        <Dialog open={!!testResult} onOpenChange={() => setTestResult(null)}> ... </Dialog>
      </div>
    );
    ```

- [ ] 为 ProvidersPage 编写单元测试
  - 测试文件: `web/src/__tests__/config-providers-page.test.ts`
  - 提取纯逻辑函数用于测试:

    ```typescript
    // 在 ProvidersPage.tsx 中导出用于测试的纯函数
    export function validateProviderForm(name: string, isEdit: boolean): string | null {
      if (!name.trim()) return "名称不能为空";
      if (!isEdit && (name.length < 1 || name.length > 64)) return "名称长度须在 1-64 字符之间";
      return null;
    }
    export function buildProviderPayload(apiKey: string, baseURL: string, timeout: string): Record<string, unknown> {
      const data: Record<string, unknown> = {};
      if (apiKey) data.apiKey = apiKey;
      if (baseURL) data.baseURL = baseURL;
      if (timeout) data.timeout = parseInt(timeout);
      return data;
    }
    ```

  - 测试场景:
    - validateProviderForm("", false) → "名称不能为空"
    - validateProviderForm("openai", false) → null
    - validateProviderForm("a".repeat(65), false) → "名称长度须在 1-64 字符之间"
    - buildProviderPayload("key123", "", "") → { apiKey: "key123" }
    - buildProviderPayload("", "<http://api.test.com>", "5000") → { baseURL: "<http://api.test.com>", timeout: 5000 }
    - buildProviderPayload("", "", "") → {}
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-providers-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] ProvidersPage 文件存在
  - `test -f /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/ProvidersPage.tsx && echo "OK"`
  - 预期: 输出 OK
- [ ] 导出 ProvidersPage 命名导出
  - `grep "export function ProvidersPage" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/ProvidersPage.tsx`
  - 预期: 匹配到导出
- [ ] 前端构建通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -3`
  - 预期: 构建成功

---

### Task 7: 模型（Models）页面

**背景:**
实现 Models 配置管理页面，分为两个区域：顶部 Card 展示当前主模型和轻量模型的配置（Select 下拉切换），下方 DataTable 展示可用模型列表（只读，支持搜索排序）。Models 页面不需要 CRUD 弹窗和批量操作，是 4 个页面中最简单的。切换模型后即时保存。
**修改原因:** 当前无 Models 前端页面，后端 API 已就绪。
**上下游影响:** 依赖 Task 2 的 API Client（apiGetModels、apiSetModels、apiRefreshModels）和 Task 3-4 的共享组件。

**涉及文件:**

- 新建: `web/src/pages/ModelsPage.tsx`

**执行步骤:**

- [ ] 创建 ModelsPage 组件
  - 新建文件: `web/src/pages/ModelsPage.tsx`
  - 导出: `export function ModelsPage()`
  - 导入:

    ```typescript
    import { useState, useCallback, useEffect, useMemo } from "react";
    import { toast } from "sonner";
    import { DataTable, type Column } from "@/components/config/DataTable";
    import { StatusBadge } from "@/components/config/StatusBadge";
    import { Button } from "@/components/ui/button";
    import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
    import { apiGetModels, apiSetModels, apiRefreshModels } from "../api/client";
    import type { ModelEntry, ModelConfig } from "../types/config";
    ```

- [ ] 实现页面状态管理
  - 状态:

    ```typescript
    const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [savingField, setSavingField] = useState<string | null>(null); // "model" | "small_model"
    ```

- [ ] 实现数据加载
  - `useEffect` 加载:

    ```typescript
    const loadModels = useCallback(async () => {
      setLoading(true);
      try {
        const data = await apiGetModels();
        setModelConfig(data);
      } catch (e) {
        toast.error("加载模型配置失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setLoading(false);
      }
    }, []);
    useEffect(() => { loadModels(); }, [loadModels]);
    ```

- [ ] 实现模型切换即时保存
  - handleModelChange:

    ```typescript
    const handleModelChange = async (field: "model" | "small_model", value: string) => {
      setSavingField(field);
      try {
        const result = await apiSetModels({ [field]: value });
        setModelConfig((prev) => prev ? { ...prev, current: result } : prev);
        toast.success("模型已更新");
      } catch (e) {
        toast.error("更新失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setSavingField(null);
      }
    };
    ```

- [ ] 实现刷新可用模型
  - handleRefresh:

    ```typescript
    const handleRefresh = async () => {
      setRefreshing(true);
      try {
        await apiRefreshModels();
        await loadModels();
        toast.success("模型列表已刷新");
      } catch (e) {
        toast.error("刷新失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setRefreshing(false);
      }
    };
    ```

- [ ] 实现 Select 选项列表（含手动输入支持）
  - 位置: ModelsPage 函数内
  - 构建下拉选项:

    ```typescript
    const modelOptions = useMemo(() => {
      if (!modelConfig) return [];
      return modelConfig.available.map((m) => ({ value: m.id, label: `${m.label} (${m.provider})` }));
    }, [modelConfig]);
    ```

  - 手动输入状态:

    ```typescript
    const [customModel, setCustomModel] = useState("");
    const [customSmallModel, setCustomSmallModel] = useState("");
    ```

  - 手动输入逻辑: 每个 Select 下方追加一个 Input（placeholder="或手动输入模型 ID"），当 Input 值非空时，优先使用 Input 值调用 handleModelChange
  - 原因: spec-design.md 要求 Select "选项来自 available 列表 + 允许手动输入"

- [ ] 组装页面 JSX
  - 结构:

    ```tsx
    return (
      <div className="p-6 space-y-6">
        {/* 区域一：当前模型配置 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">当前模型配置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium w-20">主模型</label>
              <Select
                value={modelConfig?.current.model ?? ""}
                onValueChange={(v) => handleModelChange("model", v)}
                disabled={savingField === "model"}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="选择主模型" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelConfig?.current.model && (
                <StatusBadge status="configured" />
              )}
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium w-20">轻量模型</label>
              <Select
                value={modelConfig?.current.small_model ?? ""}
                onValueChange={(v) => handleModelChange("small_model", v)}
                disabled={savingField === "small_model"}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="选择轻量模型" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelConfig?.current.small_model && (
                <StatusBadge status="configured" />
              )}
            </div>
          </CardContent>
        </Card>

        {/* 区域二：可用模型列表 */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">可用模型</h2>
          <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "刷新中..." : "刷新"}
          </Button>
        </div>
        <DataTable<ModelEntry>
          columns={columns}
          data={modelConfig?.available ?? []}
          searchable
          searchPlaceholder="搜索模型..."
        />
      </div>
    );
    ```

  - DataTable 列配置:

    ```typescript
    const columns: Column<ModelEntry>[] = [
      { key: "id", header: "模型 ID", sortable: true },
      { key: "provider", header: "服务商", sortable: true },
      { key: "label", header: "显示名" },
      {
        key: "usage",
        header: "使用状态",
        render: (row) => {
          const badges: string[] = [];
          if (modelConfig?.current.model === row.id) badges.push("主模型");
          if (modelConfig?.current.small_model === row.id) badges.push("轻量模型");
          return badges.length > 0 ? (
            <div className="flex gap-1">{badges.map((b) => <StatusBadge key={b} status={b === "主模型" ? "configured" : "builtIn"} />)}</div>
          ) : "—";
        },
      },
    ];
    ```

- [ ] 为 ModelsPage 编写单元测试
  - 测试文件: `web/src/__tests__/config-models-page.test.ts`
  - 提取纯逻辑:

    ```typescript
    // ModelsPage.tsx 中导出
    export function getModelUsageStatus(modelId: string, currentModel: string | null, smallModel: string | null): string[] {
      const badges: string[] = [];
      if (currentModel === modelId) badges.push("主模型");
      if (smallModel === modelId) badges.push("轻量模型");
      return badges;
    }
    ```

  - 测试场景:
    - getModelUsageStatus("gpt-4", "gpt-4", "gpt-3.5") → ["主模型"]
    - getModelUsageStatus("gpt-3.5", "gpt-4", "gpt-3.5") → ["轻量模型"]
    - getModelUsageStatus("gpt-4", "gpt-4", "gpt-4") → ["主模型", "轻量模型"]
    - getModelUsageStatus("claude-3", "gpt-4", "gpt-3.5") → []
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-models-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] ModelsPage 文件存在
  - `test -f /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/ModelsPage.tsx && echo "OK"`
  - 预期: 输出 OK
- [ ] 导出 ModelsPage 命名导出
  - `grep "export function ModelsPage" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/ModelsPage.tsx`
  - 预期: 匹配到导出
- [ ] 前端构建通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -3`
  - 预期: 构建成功

---

### Task 8: Agent（Agents）页面

**背景:**
实现 Agents 配置管理页面，提供完整 CRUD 交互：列表展示（含搜索、排序、筛选）、新建/编辑弹窗（含模型选择、模式选择、工具多选、Prompt 编辑）、设为默认、批量删除。内置 Agent 的删除按钮在 UI 层隐藏，提供双重保护。
**修改原因:** 当前无 Agents 前端页面，后端 API 已就绪。
**上下游影响:** 依赖 Task 2 的 API Client 和 Task 3-4 的共享组件。Agent 编辑弹窗的"模型"下拉选项来自 Models API 的 available 列表。

**涉及文件:**

- 新建: `web/src/pages/AgentsPage.tsx`

**执行步骤:**

- [ ] 创建 AgentsPage 组件
  - 新建文件: `web/src/pages/AgentsPage.tsx`
  - 导出: `export function AgentsPage()`
  - 导入:

    ```typescript
    import { useState, useCallback, useEffect, useMemo } from "react";
    import { toast } from "sonner";
    import { DataTable, type Column } from "@/components/config/DataTable";
    import { FormDialog } from "@/components/config/FormDialog";
    import { ConfirmDialog } from "@/components/config/ConfirmDialog";
    import { BatchActionBar } from "@/components/config/BatchActionBar";
    import { StatusBadge } from "@/components/config/StatusBadge";
    import { Button } from "@/components/ui/button";
    import { Input } from "@/components/ui/input";
    import { Textarea } from "@/components/ui/textarea";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
    import { Label } from "@/components/ui/label";
    import {
      apiListAgents, apiCreateAgent, apiSetAgent, apiDeleteAgent, apiSetDefaultAgent,
      apiGetModels,
    } from "../api/client";
    import type { AgentInfo } from "../types/config";
    ```

- [ ] 实现页面状态管理
  - 状态:

    ```typescript
    const [agents, setAgents] = useState<AgentInfo[]>([]);
    const [defaultAgent, setDefaultAgent] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingAgent, setEditingAgent] = useState<AgentInfo | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
    const [selected, setSelected] = useState<AgentInfo[]>([]);
    const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
    const [modelOptions, setModelOptions] = useState<string[]>([]);
    // 表单字段
    const [formName, setFormName] = useState("");
    const [formModel, setFormModel] = useState("");
    const [formMode, setFormMode] = useState("primary");
    const [formSteps, setFormSteps] = useState("50");
    const [formTools, setFormTools] = useState<string[]>([]);
    const [formPrompt, setFormPrompt] = useState("");
    const [formSaving, setFormSaving] = useState(false);
    ```

  - 可用工具列表常量:

    ```typescript
    const AVAILABLE_TOOLS = [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebSearch", "WebFetch", "Agent", "TaskCreate", "TaskUpdate",
    ];
    ```

- [ ] 实现数据加载
  - 加载 agents 和 models:

    ```typescript
    const loadAgents = useCallback(async () => {
      setLoading(true);
      try {
        const data = await apiListAgents();
        setAgents(data.agents);
        setDefaultAgent(data.default_agent);
      } catch (e) {
        toast.error("加载Agent列表失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setLoading(false);
      }
    }, []);

    const loadModelOptions = useCallback(async () => {
      try {
        const data = await apiGetModels();
        setModelOptions(data.available.map((m) => m.id));
      } catch { /* 静默失败，模型选项非关键 */ }
    }, []);

    useEffect(() => { loadAgents(); loadModelOptions(); }, [loadAgents, loadModelOptions]);
    ```

- [ ] 实现 DataTable 列配置
  - 列定义:

    ```typescript
    const columns: Column<AgentInfo>[] = [
      { key: "name", header: "名称", sortable: true, filterable: true },
      {
        key: "builtIn",
        header: "类型",
        filterable: true,
        render: (row) => <StatusBadge status={row.builtIn ? "builtIn" : "custom"} />,
      },
      { key: "model", header: "模型", sortable: true },
      {
        key: "mode",
        header: "模式",
        filterable: true,
        render: (row) => row.mode ? <StatusBadge status={row.mode} /> : "—",
      },
      {
        key: "default",
        header: "默认",
        filterable: true,
        render: (row) => row.name === defaultAgent ? "★" : "",
      },
    ];
    ```

- [ ] 实现新建/编辑弹窗
  - handleOpenCreate:

    ```typescript
    const handleOpenCreate = () => {
      setEditingAgent(null);
      setFormName(""); setFormModel(modelOptions[0] || ""); setFormMode("primary");
      setFormSteps("50"); setFormTools([]); setFormPrompt("");
      setDialogOpen(true);
    };
    ```

  - handleOpenEdit:

    ```typescript
    const handleOpenEdit = async (agent: AgentInfo) => {
      setEditingAgent(agent);
      setFormName(agent.name); setFormModel(agent.model || "");
      setFormMode(agent.mode || "primary"); setFormPrompt("");
      // 获取完整 agent 详情
      try {
        const detail = await apiGetAgent(agent.name);
        setFormSteps(String(detail.steps ?? 50));
        setFormTools(Array.isArray(detail.tools) ? detail.tools : []);
        setFormPrompt((detail.prompt as string) || "");
      } catch {
        setFormSteps("50"); setFormTools([]);
      }
      setDialogOpen(true);
    };
    ```

  - handleSave:

    ```typescript
    const handleSave = async () => {
      const name = formName.trim();
      if (!name || name.length < 1 || name.length > 64) {
        toast.error("名称长度须在 1-64 字符之间"); return;
      }
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
        toast.error("名称只能包含小写字母、数字和单连字符"); return;
      }
      const steps = parseInt(formSteps);
      if (isNaN(steps) || steps < 1 || steps > 200) {
        toast.error("步数须在 1-200 之间"); return;
      }
      setFormSaving(true);
      try {
        const data: Record<string, unknown> = {
          model: formModel || null,
          mode: formMode,
          steps,
          tools: formTools,
          prompt: formPrompt || null,
        };
        if (editingAgent) {
          await apiSetAgent(name, data);
          toast.success("Agent已更新");
        } else {
          await apiCreateAgent(name, data);
          toast.success("Agent已创建");
        }
        setDialogOpen(false);
        loadAgents();
      } catch (e) {
        toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setFormSaving(false);
      }
    };
    ```

- [ ] 实现弹窗 JSX（含工具 Checkbox 多选组）
  - 表单 JSX:

    ```tsx
    <FormDialog open={dialogOpen} onOpenChange={setDialogOpen}
      title={editingAgent ? "编辑Agent" : "新建Agent"} onSubmit={handleSave} loading={formSaving}>
      <div className="space-y-4 max-h-[60vh] overflow-y-auto">
        <div>
          <Label>名称</Label>
          <Input value={formName} onChange={(e) => setFormName(e.target.value)}
            disabled={!!editingAgent} placeholder="例如 my-agent" />
        </div>
        <div>
          <Label>模型</Label>
          <Select value={formModel} onValueChange={setFormModel}>
            <SelectTrigger><SelectValue placeholder="选择模型" /></SelectTrigger>
            <SelectContent>
              {modelOptions.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>模式</Label>
          <Select value={formMode} onValueChange={setFormMode}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="primary">primary</SelectItem>
              <SelectItem value="subagent">subagent</SelectItem>
              <SelectItem value="all">all</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>步数 (1-200)</Label>
          <Input type="number" value={formSteps} onChange={(e) => setFormSteps(e.target.value)} min={1} max={200} />
        </div>
        <div>
          <Label>工具</Label>
          <div className="flex flex-wrap gap-2 mt-1">
            {AVAILABLE_TOOLS.map((tool) => (
              <label key={tool} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={formTools.includes(tool)}
                  onChange={(e) => {
                    setFormTools((prev) => e.target.checked
                      ? [...prev, tool] : prev.filter((t) => t !== tool));
                  }} />
                {tool}
              </label>
            ))}
          </div>
        </div>
        <div>
          <Label>Prompt</Label>
          <Textarea value={formPrompt} onChange={(e) => setFormPrompt(e.target.value)}
            rows={4} placeholder="可选，自定义 Agent 提示词" />
        </div>
      </div>
    </FormDialog>
    ```

- [ ] 实现设为默认、删除和批量删除
  - handleSetDefault:

    ```typescript
    const handleSetDefault = async (name: string) => {
      try {
        await apiSetDefaultAgent(name);
        setDefaultAgent(name);
        toast.success(`已将 "${name}" 设为默认Agent`);
      } catch (e) {
        toast.error("设置失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```

  - 删除: 仅允许删除自定义 Agent（内置 Agent 在操作列不显示删除按钮）

    ```typescript
    const confirmBatchDelete = async () => {
      const customAgents = selected.filter((a) => !a.builtIn);
      try {
        await Promise.all(customAgents.map((a) => apiDeleteAgent(a.name)));
        toast.success(`已删除 ${customAgents.length} 个Agent`);
        setBatchConfirmOpen(false);
        setSelected([]);
        loadAgents();
      } catch (e) {
        toast.error("批量删除失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```

- [ ] 组装页面 JSX
  - 操作列渲染函数:

    ```tsx
    actions={(row) => (
      <div className="flex gap-2">
        {row.name !== defaultAgent && (
          <Button size="sm" variant="outline" onClick={() => handleSetDefault(row.name)}>设为默认</Button>
        )}
        <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
        {!row.builtIn && (
          <Button size="sm" variant="destructive" onClick={() => { setDeleteTarget(row.name); setConfirmOpen(true); }}>删除</Button>
        )}
      </div>
    )}
    ```

- [ ] 为 AgentsPage 编写单元测试
  - 测试文件: `web/src/__tests__/config-agents-page.test.ts`
  - 提取纯逻辑:

    ```typescript
    // AgentsPage.tsx 中导出
    export function isValidAgentNameInput(name: string): boolean {
      return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
        && name.length >= 1 && name.length <= 64;
    }
    export function isValidStepsInput(steps: string): boolean {
      const n = parseInt(steps);
      return !isNaN(n) && n >= 1 && n <= 200;
    }
    ```

  - 测试场景:
    - isValidAgentNameInput("my-agent") → true
    - isValidAgentNameInput("MY-AGENT") → false
    - isValidAgentNameInput("a") → true
    - isValidAgentNameInput("a--b") → false（双连字符）
    - isValidAgentNameInput("") → false
    - isValidStepsInput("50") → true
    - isValidStepsInput("0") → false
    - isValidStepsInput("201") → false
    - isValidStepsInput("abc") → false
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-agents-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] AgentsPage 文件存在
  - `test -f /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/AgentsPage.tsx && echo "OK"`
  - 预期: 输出 OK
- [ ] 导出 AgentsPage 命名导出
  - `grep "export function AgentsPage" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/AgentsPage.tsx`
  - 预期: 匹配到导出
- [ ] 前端构建通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -3`
  - 预期: 构建成功

---

### Task 9: 技能（Skills）页面

**背景:**
实现 Skills 配置管理页面，提供完整 CRUD 交互：列表展示（含搜索、排序、筛选）、新建/编辑弹窗（内嵌 Markdown 编辑器：左侧编辑 + 右侧实时预览）、启用/禁用切换、批量操作（启用/禁用/删除）。删除操作需 ConfirmDialog 提示"此操作不可逆"。编辑已禁用的 skill 时，保存后自动启用（后端 setSkill 行为保证）。
**修改原因:** 当前无 Skills 前端页面，后端 API 已就绪。
**上下游影响:** 依赖 Task 2 的 API Client 和 Task 3-4 的共享组件。使用 react-markdown（Task 1 安装）进行 Markdown 渲染。

**涉及文件:**

- 新建: `web/src/pages/SkillsPage.tsx`

**执行步骤:**

- [ ] 创建 SkillsPage 组件
  - 新建文件: `web/src/pages/SkillsPage.tsx`
  - 导出: `export function SkillsPage()`
  - 导入:

    ```typescript
    import { useState, useCallback, useEffect } from "react";
    import { toast } from "sonner";
    import Markdown from "react-markdown";
    import { DataTable, type Column } from "@/components/config/DataTable";
    import { FormDialog } from "@/components/config/FormDialog";
    import { ConfirmDialog } from "@/components/config/ConfirmDialog";
    import { BatchActionBar } from "@/components/config/BatchActionBar";
    import { StatusBadge } from "@/components/config/StatusBadge";
    import { Button } from "@/components/ui/button";
    import { Input } from "@/components/ui/input";
    import { Textarea } from "@/components/ui/textarea";
    import {
      apiListSkills, apiGetSkill, apiSetSkill, apiDeleteSkill, apiEnableSkill, apiDisableSkill,
    } from "../api/client";
    import type { SkillInfo } from "../types/config";
    ```

- [ ] 实现页面状态管理
  - 状态:

    ```typescript
    const [skills, setSkills] = useState<SkillInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
    const [selected, setSelected] = useState<SkillInfo[]>([]);
    const [batchAction, setBatchAction] = useState<"enable" | "disable" | "delete" | null>(null);
    const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
    // 表单字段
    const [formName, setFormName] = useState("");
    const [formDescription, setFormDescription] = useState("");
    const [formLicense, setFormLicense] = useState("");
    const [formCompatibility, setFormCompatibility] = useState("");
    const [formContent, setFormContent] = useState("");
    const [formSaving, setFormSaving] = useState(false);
    ```

- [ ] 实现数据加载
  - 加载:

    ```typescript
    const loadSkills = useCallback(async () => {
      setLoading(true);
      try {
        const data = await apiListSkills();
        setSkills(data);
      } catch (e) {
        toast.error("加载技能列表失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setLoading(false);
      }
    }, []);
    useEffect(() => { loadSkills(); }, [loadSkills]);
    ```

- [ ] 实现 DataTable 列配置
  - 列定义:

    ```typescript
    const columns: Column<SkillInfo>[] = [
      { key: "name", header: "名称", sortable: true, filterable: true },
      { key: "description", header: "描述" },
      {
        key: "enabled",
        header: "状态",
        filterable: true,
        render: (row) => <StatusBadge status={row.enabled ? "enabled" : "disabled"} />,
      },
    ];
    ```

- [ ] 实现新建/编辑弹窗（含 Markdown 编辑器）
  - handleOpenCreate:

    ```typescript
    const handleOpenCreate = () => {
      setEditingSkill(null);
      setFormName(""); setFormDescription(""); setFormLicense("");
      setFormCompatibility(""); setFormContent("");
      setDialogOpen(true);
    };
    ```

  - handleOpenEdit:

    ```typescript
    const handleOpenEdit = async (skill: SkillInfo) => {
      setEditingSkill(skill);
      try {
        const detail = await apiGetSkill(skill.name);
        setFormName(detail.name); setFormDescription(detail.description);
        setFormContent(detail.content);
        setFormLicense(detail.metadata?.license || "");
        setFormCompatibility(detail.metadata?.compatibility || "");
      } catch (e) {
        toast.error("加载技能详情失败");
      }
      setDialogOpen(true);
    };
    ```

  - handleSave:

    ```typescript
    const handleSave = async () => {
      if (!formName.trim()) { toast.error("名称不能为空"); return; }
      if (!formContent.trim()) { toast.error("内容不能为空"); return; }
      setFormSaving(true);
      try {
        const metadata: Record<string, string> = {};
        if (formLicense) metadata.license = formLicense;
        if (formCompatibility) metadata.compatibility = formCompatibility;
        await apiSetSkill(formName, {
          description: formDescription,
          content: formContent,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
        toast.success(editingSkill ? "技能已更新" : "技能已创建");
        setDialogOpen(false);
        loadSkills();
      } catch (e) {
        toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setFormSaving(false);
      }
    };
    ```

  - 弹窗 JSX（含 Markdown 编辑器左右分栏）:

    ```tsx
    <FormDialog open={dialogOpen} onOpenChange={setDialogOpen}
      title={editingSkill ? "编辑技能" : "新建技能"} onSubmit={handleSave}
      loading={formSaving} width="sm:max-w-4xl">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium">名称</label>
            <Input value={formName} onChange={(e) => setFormName(e.target.value)}
              disabled={!!editingSkill} placeholder="技能名称" />
          </div>
          <div>
            <label className="text-sm font-medium">描述</label>
            <Input value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="可选" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium">许可证</label>
            <Input value={formLicense} onChange={(e) => setFormLicense(e.target.value)} placeholder="可选" />
          </div>
          <div>
            <label className="text-sm font-medium">兼容性</label>
            <Input value={formCompatibility} onChange={(e) => setFormCompatibility(e.target.value)} placeholder="可选" />
          </div>
        </div>
        {/* Markdown 编辑器：左侧编辑 + 右侧预览 */}
        <div className="grid grid-cols-2 gap-4 border rounded-lg overflow-hidden min-h-[300px]">
          <div className="p-2 border-r">
            <label className="text-sm font-medium text-muted-foreground">编辑</label>
            <Textarea
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              className="min-h-[260px] font-mono text-sm border-0 focus-visible:ring-0 p-2"
              placeholder="输入 Markdown 内容..."
            />
          </div>
          <div className="p-2 overflow-y-auto bg-muted/30">
            <label className="text-sm font-medium text-muted-foreground">预览</label>
            <div className="prose prose-sm dark:prose-invert max-w-none mt-1">
              <Markdown>{formContent}</Markdown>
            </div>
          </div>
        </div>
      </div>
    </FormDialog>
    ```

- [ ] 实现启用/禁用切换（即时操作，不需确认）
  - handleToggle:

    ```typescript
    const handleToggle = async (skill: SkillInfo) => {
      try {
        if (skill.enabled) {
          await apiDisableSkill(skill.name);
          toast.success(`已禁用 "${skill.name}"`);
        } else {
          await apiEnableSkill(skill.name);
          toast.success(`已启用 "${skill.name}"`);
        }
        loadSkills();
      } catch (e) {
        toast.error("操作失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```

- [ ] 实现删除和批量操作
  - 单个删除:

    ```typescript
    const confirmDelete = async () => {
      if (!deleteTarget) return;
      try {
        await apiDeleteSkill(deleteTarget);
        toast.success("技能已删除");
        setConfirmOpen(false);
        loadSkills();
      } catch (e) {
        toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```

  - 批量操作:

    ```typescript
    const handleBatchAction = (action: "enable" | "disable" | "delete") => {
      setBatchAction(action);
      setBatchConfirmOpen(true);
    };
    const confirmBatchAction = async () => {
      try {
        if (batchAction === "delete") {
          await Promise.all(selected.map((s) => apiDeleteSkill(s.name)));
          toast.success(`已删除 ${selected.length} 个技能`);
        } else if (batchAction === "enable") {
          await Promise.all(selected.filter((s) => !s.enabled).map((s) => apiEnableSkill(s.name)));
          toast.success(`已启用 ${selected.length} 个技能`);
        } else {
          await Promise.all(selected.filter((s) => s.enabled).map((s) => apiDisableSkill(s.name)));
          toast.success(`已禁用 ${selected.length} 个技能`);
        }
        setBatchConfirmOpen(false);
        setSelected([]);
        loadSkills();
      } catch (e) {
        toast.error("批量操作失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```

- [ ] 组装页面 JSX
  - 操作列:

    ```tsx
    actions={(row) => (
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => handleToggle(row)}>
          {row.enabled ? "禁用" : "启用"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
        <Button size="sm" variant="destructive" onClick={() => { setDeleteTarget(row.name); setConfirmOpen(true); }}>删除</Button>
      </div>
    )}
    ```

  - 批量操作栏:

    ```tsx
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
    ```

  - 确认弹窗:

    ```tsx
    <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
      title="确认删除" description={`此操作不可逆。确定要删除技能 "${deleteTarget}" 吗？`}
      variant="destructive" onConfirm={confirmDelete} />
    <ConfirmDialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}
      title={`批量${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}确认`}
      description={`确定要${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}选中的 ${selected.length} 个技能吗？${batchAction === "delete" ? "此操作不可逆。" : ""}`}
      variant={batchAction === "delete" ? "destructive" : "default"}
      onConfirm={confirmBatchAction} />
    ```

- [ ] 为 SkillsPage 编写单元测试
  - 测试文件: `web/src/__tests__/config-skills-page.test.ts`
  - 提取纯逻辑:

    ```typescript
    // SkillsPage.tsx 中导出
    export function validateSkillForm(name: string, content: string): string | null {
      if (!name.trim()) return "名称不能为空";
      if (!content.trim()) return "内容不能为空";
      return null;
    }
    export function buildSkillMetadata(license: string, compatibility: string): Record<string, string> | undefined {
      const metadata: Record<string, string> = {};
      if (license) metadata.license = license;
      if (compatibility) metadata.compatibility = compatibility;
      return Object.keys(metadata).length > 0 ? metadata : undefined;
    }
    ```

  - 测试场景:
    - validateSkillForm("", "content") → "名称不能为空"
    - validateSkillForm("my-skill", "") → "内容不能为空"
    - validateSkillForm("my-skill", "# Hello") → null
    - buildSkillMetadata("", "") → undefined
    - buildSkillMetadata("MIT", "") → { license: "MIT" }
    - buildSkillMetadata("MIT", "v1.0") → { license: "MIT", compatibility: "v1.0" }
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-skills-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] SkillsPage 文件存在
  - `test -f /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/SkillsPage.tsx && echo "OK"`
  - 预期: 输出 OK
- [ ] 导出 SkillsPage 命名导出
  - `grep "export function SkillsPage" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/SkillsPage.tsx`
  - 预期: 匹配到导出
- [ ] 使用 react-markdown 组件
  - `grep "react-markdown" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/SkillsPage.tsx`
  - 预期: 匹配到导入或使用
- [ ] 前端构建通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -3`
  - 预期: 构建成功

---

### Task [总体验收]: Settings UI 全功能验收

**前置条件:**

- 启动后端服务: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev`
- 启动前端开发服务器: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev:web`
- 访问 `http://localhost:5173/code/`

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test 2>&1 | tail -15`
   - 预期: 全部测试通过
   - 失败排查: 检查各 Task 的测试步骤

2. 验证前端构建通过
   - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5`
   - 预期: 构建成功，无 TypeScript 错误
   - 失败排查: 检查 Task 5 的懒加载导入与 Task 6-9 的页面文件名是否匹配

3. 验证 Sidebar 正确显示 7 个平铺入口
   - 浏览器访问 `/code/`，检查 Sidebar 显示：仪表盘、会话、API 密钥、服务商、模型、Agent、技能、退出
   - 预期: 7 个入口均可见，图标和中文标签正确
   - 失败排查: 检查 Task 5 的 footerItems 配置

4. 验证 4 个模块页面懒加载生效
   - 点击 Sidebar 的服务商/模型/Agent/技能入口，观察页面加载
   - 预期: 页面正常渲染，URL 变为 `/code/providers`、`/code/models`、`/code/agents`、`/code/skills`
   - 浏览器 DevTools Network 面板确认各页面 JS 为独立 chunk
   - 失败排查: 检查 Task 5 的 lazy 导入和 Task 6-9 的导出

5. 验证 Providers 页面完整功能
   - 浏览器访问 `/code/providers`
   - 预期: 列表展示、新建弹窗（API Key 密码框）、编辑、测试连接（loading → 成功弹窗展示模型列表）、删除确认、批量操作均正常
   - 失败排查: 检查 Task 6

6. 验证 Models 页面完整功能
   - 浏览器访问 `/code/models`
   - 预期: 配置卡片可切换主模型和轻量模型，刷新可用模型列表正常
   - 失败排查: 检查 Task 7

7. 验证 Agents 页面完整功能
   - 浏览器访问 `/code/agents`
   - 预期: 列表展示、新建弹窗（含工具 Checkbox 多选）、编辑弹窗、内置 Agent 不可删除、设为默认正常
   - 失败排查: 检查 Task 8

8. 验证 Skills 页面完整功能
   - 浏览器访问 `/code/skills`
   - 预期: 列表展示、Markdown 编辑器（左侧编辑 + 右侧实时预览）、启用/禁用即时切换、删除确认提示"此操作不可逆"、批量操作正常
   - 失败排查: 检查 Task 9

9. 验证 Toast 通知正常工作
   - 在任意模块执行操作（如删除），观察 Toast 提示
   - 预期: 右上角出现成功/错误 Toast 通知
   - 失败排查: 检查 Task 1 的 Toaster 挂载

10. 验证搜索、筛选、排序、分页功能
    - 在 Providers 列表输入搜索词、点击列头排序、切换分页
    - 预期: DataTable 交互正常
    - 失败排查: 检查 Task 3 的 DataTable 实现
