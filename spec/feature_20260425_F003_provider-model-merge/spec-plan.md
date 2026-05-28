# Provider-Model 合并执行计划

**目标:** 将服务商和模型两个独立页面合并为统一的"模型"页面，以服务商为主体展示其下所有模型，模型配置改为弹窗交互

**技术栈:** React 19, TanStack Table 8 (getExpandedRowModel), Radix UI Dialog, Bun Test, Vite

**设计文档:** spec-design.md

## 改动总览

本次改动将"服务商"和"模型"两个独立页面合并为统一的"模型"页面。涉及文件分为三类：(1) DataTable 组件新增 defaultExpandAll 属性；(2) 新建 ModelConfigDialog 组件；(3) ModelsPage 完全重写合并两个页面功能，App.tsx 清理路由和侧边栏，最后删除 ProvidersPage.tsx。
各 Task 按线性依赖顺序执行：Task 1（DataTable 扩展）→ Task 2（ModelConfigDialog）→ Task 3（ModelsPage 合并，依赖前两者）→ Task 4（路由清理，依赖 Task 3）→ Task 5（删除废弃文件，依赖 Task 3+4）。
关键设计决策：ModelSubrow、validateProviderForm、buildProviderPayload 等函数直接从 ProvidersPage 迁移到 ModelsPage 内联（不抽取为独立文件），因为它们仅在 ModelsPage 中使用，保持与现有架构一致的页面内聚风格。

---

### Task 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**

- [x] 验证 Bun 运行时和测试框架可用
  - `bun --version`
  - `bun test --help 2>&1 | head -3`
- [x] 验证前端构建工具可用
  - `cd web && bunx vite build --mode development 2>&1 | tail -5`

**检查步骤:**

- [x] 构建命令执行成功
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -3`
  - 预期: 输出包含 "built in" 且无 error
- [x] 测试命令可用
  - `bun test web/src/__tests__/config-datatable.test.ts 2>&1 | tail -3`
  - 预期: 测试框架正常启动，已有测试通过

---

### Task 1: DataTable defaultExpandAll 属性支持

**背景:**
合并后的模型页面需要以服务商为主体展示，所有服务商行默认展开显示模型子表格。当前 DataTable 的 expanded state 初始化为空对象 `{}`，所有行默认折叠。需要新增 `defaultExpandAll` prop 使其支持初始化全部展开。
本 Task 是 Task 3（ModelsPage 合并重写）的前置依赖，Task 3 将在 DataTable 调用处传入 `defaultExpandAll`。

**涉及文件:**

- 修改: `web/components/config/DataTable.tsx`
- 修改: `web/src/__tests__/config-datatable.test.ts`

**执行步骤:**

- [x] 在 `DataTableProps` 接口中新增 `defaultExpandAll?: boolean` 属性
  - 位置: `web/components/config/DataTable.tsx` L38 `DataTableProps<T>` 接口，在 `pageSize?: number;` 之前插入
  - 新增: `defaultExpandAll?: boolean;`

- [x] 修改 DataTable 组件函数签名，解构新增 `defaultExpandAll` 参数
  - 位置: `web/components/config/DataTable.tsx` L150-162 组件参数解构
  - 在 `pageSize = 10,` 后追加 `defaultExpandAll,`

- [x] 修改 expanded state 初始化逻辑：当 `defaultExpandAll` 为 true 且 data 非空时，将所有行的 ID 初始化为 true
  - 位置: `web/components/config/DataTable.tsx` L165，替换当前 `useState<ExpandedState>({})`
  - 替换为使用函数初始化：

  ```typescript
  const [expanded, setExpanded] = useState<ExpandedState>(() => {
    if (!defaultExpandAll) return {};
    const initial: ExpandedState = {};
    data.forEach((row, index) => {
      const rowId = rowKey ? rowKey(row) : String(index);
      initial[rowId] = true;
    });
    return initial;
  });
  ```

  - 原因: `defaultExpandAll` 需要在首次渲染时就计算好所有行的 expanded 状态，使用 lazy initializer 避免每次渲染重计算

- [x] 新增 `useEffect` 在 data 变化时同步更新 expanded state（当 `defaultExpandAll` 为 true 时自动展开新行）
  - 位置: `web/components/config/DataTable.tsx`，在 expanded state 声明之后、`globalFilterFn` 声明之前（~L168）插入

  ```typescript
  useEffect(() => {
    if (!defaultExpandAll) return;
    setExpanded((prev) => {
      const next: ExpandedState = {};
      data.forEach((row, index) => {
        const rowId = rowKey ? rowKey(row) : String(index);
        next[rowId] = prev[rowId] !== undefined ? prev[rowId] : true;
      });
      return next;
    });
  }, [data, rowKey, defaultExpandAll]);
  ```

  - 原因: 当 data 异步加载完成后（如 providers 列表从 API 返回），需要自动展开新加入的行，同时保留用户手动折叠的行状态（`prev[rowId] !== undefined` 时保持原值）

- [x] 为 defaultExpandAll 逻辑编写单元测试
  - 测试文件: `web/src/__tests__/config-datatable.test.ts`
  - 测试场景:
    - `buildInitialExpandedState` (抽取的纯函数): 3 条数据 + rowKey → 返回 `{ "key1": true, "key2": true, "key3": true }`
    - `buildInitialExpandedState`: 无 rowKey → 使用 index 作为 key → 返回 `{ "0": true, "1": true, "2": true }`
    - `buildInitialExpandedState`: 空 data → 返回 `{}`
  - 注意: 将 useState 初始化函数中的逻辑抽取为独立导出函数 `buildInitialExpandedState(data: T[], rowKey?: RowKeyGetter<T>): ExpandedState`，以便测试
  - 运行命令: `bun test web/src/__tests__/config-datatable.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 DataTableProps 接口包含 defaultExpandAll 属性
  - `grep -n "defaultExpandAll" web/components/config/DataTable.tsx`
  - 预期: 出现至少 3 处（接口定义、参数解构、useState 初始化）
- [x] 验证导出函数存在
  - `grep -n "buildInitialExpandedState" web/components/config/DataTable.tsx`
  - 预期: 出现 export 函数定义
- [x] 运行 DataTable 测试
  - `bun test web/src/__tests__/config-datatable.test.ts`
  - 预期: 所有测试通过，无失败

---

### Task 2: ModelConfigDialog 新组件

**背景:**
合并后的模型页面将模型配置（主模型/轻量模型选择）从独立 Card 区域改为标题栏齿轮 icon 弹窗交互，节省页面空间并简化布局。当前 ModelsPage 中已有完整的模型选择 + API 保存逻辑，需要提取为独立组件供 Task 3 合并后的 ModelsPage 使用。
本 Task 输出 `ModelConfigDialog` 组件，被 Task 3（ModelsPage 合并重写）在页面标题栏引入。

**涉及文件:**

- 新建: `web/src/components/config/ModelConfigDialog.tsx`
- 新建: `web/src/__tests__/config-model-config-dialog.test.ts`

**执行步骤:**

- [x] 新建 `ModelConfigDialog.tsx` 组件文件
  - 位置: `web/src/components/config/ModelConfigDialog.tsx`
  - 导入依赖:

    ```typescript
    import { useState } from "react";
    import { toast } from "sonner";
    import { Settings } from "lucide-react";
    import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
    import { Input } from "@/components/ui/input";
    import { apiSetModels } from "../../api/client";
    import type { ModelEntry } from "../../types/config";
    ```

  - 导出纯函数 `buildModelOptions`（便于单元测试）:

    ```typescript
    export function buildModelOptions(available: ModelEntry[]): { value: string; label: string }[] {
      return available.map((m) => ({ value: m.fullId, label: `${m.label} (${m.provider})` }));
    }
    ```

  - Props 接口:

    ```typescript
    interface ModelConfigDialogProps {
      currentModel: string | null;
      currentSmallModel: string | null;
      available: ModelEntry[];
    }
    ```

  - 组件结构:
    - 顶层: `<button>` 包裹 `<Settings className="h-5 w-5" />`，className 为 `"p-2 rounded-md hover:bg-muted"`，点击触发 `setOpen(true)`
    - `<Dialog open={open} onOpenChange={setOpen}>`
    - `<DialogContent>` 内:
      - `<DialogHeader>` + `<DialogTitle>模型配置</DialogTitle>` + `<DialogDescription>选择主模型和轻量模型</DialogDescription>`
      - 主模型 Select: `value={currentModel ?? ""}`, `onValueChange={(v) => handleModelChange("model", v)}`
      - 主模型 Input: 手动输入，`onBlur` 和 `onKeyDown Enter` 时调用 `handleCustomModel`
      - 轻量模型 Select: `value={currentSmallModel ?? ""}`, `onValueChange={(v) => handleModelChange("small_model", v)}`
      - 轻量模型 Input: 同上
    - `handleModelChange` 逻辑: 调用 `apiSetModels({ [field]: value })`，成功后 `toast.success("模型已更新")`，失败 `toast.error(...)`
    - `handleCustomModel` 逻辑: `value.trim()` 非空时调用 `handleModelChange`
  - 组件导出: `export function ModelConfigDialog({ currentModel, currentSmallModel, available }: ModelConfigDialogProps)`

- [x] 为 `buildModelOptions` 纯函数编写单元测试
  - 测试文件: `web/src/__tests__/config-model-config-dialog.test.ts`
  - 测试场景:
    - 正常 available 列表 → 返回正确的 `{ value: fullId, label: "label (provider)" }` 数组
    - 空 available 列表 → 返回空数组 `[]`
    - available 中含 null/undefined 字段 → 不崩溃，正常拼接
  - 运行命令: `bun test web/src/__tests__/config-model-config-dialog.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 ModelConfigDialog 组件文件存在且导出正确
  - `grep -n "export function ModelConfigDialog" web/src/components/config/ModelConfigDialog.tsx`
  - 预期: 存在导出声明
- [x] 验证 buildModelOptions 纯函数导出
  - `grep -n "export function buildModelOptions" web/src/components/config/ModelConfigDialog.tsx`
  - 预期: 存在导出声明
- [x] 验证 Settings 图标引入
  - `grep -n "Settings" web/src/components/config/ModelConfigDialog.tsx`
  - 预期: 存在 import 和 JSX 使用
- [x] 运行测试
  - `bun test web/src/__tests__/config-model-config-dialog.test.ts`
  - 预期: 所有测试通过

---

### Task 3: ModelsPage 合并重写

**背景:**
当前"服务商"和"模型"是两个独立页面，用户需频繁切换且信息分散。合并为统一"模型"页面后，以服务商为主体展示其下所有模型子表格，模型配置改为标题栏齿轮 icon 弹窗。
本 Task 依赖 Task 1（DataTable defaultExpandAll）和 Task 2（ModelConfigDialog），将 ProvidersPage 中所有逻辑迁移到 ModelsPage，实现页面合并。Task 5 负责删除 ProvidersPage 文件。

**涉及文件:**

- 修改: `web/src/pages/ModelsPage.tsx`（完全重写）
- 修改: `web/src/__tests__/config-providers-page.test.ts`（导入路径从 ProvidersPage 改为 ModelsPage）

**执行步骤:**

- [x] 重写 `web/src/pages/ModelsPage.tsx` 文件头部的 import 声明，合并 ProvidersPage 和 ModelsPage 的所有依赖
  - 位置: `web/src/pages/ModelsPage.tsx` L1-L11，整体替换
  - 新 import 列表:

    ```typescript
    import { useState, useCallback, useEffect } from "react";
    import { toast } from "sonner";
    import { DataTable, type Column } from "@/components/config/DataTable";
    import { FormDialog } from "@/components/config/FormDialog";
    import { ConfirmDialog } from "@/components/config/ConfirmDialog";
    import { BatchActionBar } from "@/components/config/BatchActionBar";
    import { StatusBadge } from "@/components/config/StatusBadge";
    import { ModelConfigDialog } from "@/components/config/ModelConfigDialog";
    import { Button } from "@/components/ui/button";
    import { Input } from "@/components/ui/input";
    import { Switch } from "@/components/ui/switch";
    import { Skeleton } from "@/components/ui/skeleton";
    import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
    import {
      apiListProviders, apiSetProvider, apiTestProvider, apiDeleteProvider,
      apiGetProvider, apiAddProviderModel, apiUpdateProviderModel, apiRemoveProviderModel,
      apiGetModels,
    } from "../api/client";
    import type { ProviderInfo, ProviderModel, ModelConfig } from "../types/config";
    ```

  - 原因: 合并页面后需要同时使用服务商和模型的所有 API 及 UI 组件

- [x] 迁移 ProvidersPage 中的常量和导出函数到 ModelsPage
  - 位置: import 声明之后、`getModelUsageStatus` 函数之前
  - 从 `web/src/pages/ProvidersPage.tsx` L20-L42 复制以下内容:

    ```typescript
    const NPM_OPTIONS = [
      { id: "openai-compatible", label: "OpenAI 兼容", npm: "@ai-sdk/openai-compatible" },
      { id: "anthropic", label: "Anthropic", npm: "@ai-sdk/anthropic" },
      { id: "deepseek", label: "DeepSeek", npm: "@ai-sdk/deepseek" },
    ];
    const INPUT_MODALITY_OPTIONS = ["text", "image", "audio", "video", "pdf"] as const;
    const OUTPUT_MODALITY_OPTIONS = ["text", "image"] as const;
    ```

  - 从 `web/src/pages/ProvidersPage.tsx` L29-L42 复制 `validateProviderForm` 和 `buildProviderPayload` 函数（保留 `export`）
  - 保留现有的 `getModelUsageStatus` 导出函数（L13-L18），不修改

- [x] 迁移 `ModelSubrow` 内部组件到 ModelsPage
  - 位置: `buildProviderPayload` 函数之后、`ModelsPage` 组件函数之前
  - 从 `web/src/pages/ProvidersPage.tsx` L44-L296 完整复制 `ModelSubrow` 函数组件（注意: 该组件是 module 内部的非导出组件，不添加 export）
  - `ModelSubrow` 的 props 签名保持不变: `{ providerId: string; models: ProviderModel[]; onModelChange: (action: "delete" | "save", providerId: string, modelId?: string) => void }`
  - 原因: ModelSubrow 包含完整的模型 CRUD 逻辑（新增/编辑/删除对话框、表单状态、API 调用），直接迁移无需修改

- [x] 重写 `ModelsPage` 组件函数主体
  - 位置: 替换现有 `export function ModelsPage()` 整个函数体
  - state 声明 — 合并两个页面的状态:

    ```typescript
    // 来自 ProvidersPage 的状态
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [providerModels, setProviderModels] = useState<Record<string, ProviderModel[]>>({});
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingProvider, setEditingProvider] = useState<ProviderInfo | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
    const [selected, setSelected] = useState<ProviderInfo[]>([]);
    const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
    const [testResult, setTestResult] = useState<{ name: string; models: string[]; warning?: string } | { name: string; error: string } | null>(null);
    const [testing, setTesting] = useState<string | null>(null);
    const [addedModelIds, setAddedModelIds] = useState<Set<string>>(new Set());
    const [formName, setFormName] = useState("");
    const [formApiKey, setFormApiKey] = useState("");
    const [formBaseURL, setFormBaseURL] = useState("");
    const [formNpm, setFormNpm] = useState("openai-compatible");
    const [formDisplayName, setFormDisplayName] = useState("");
    const [formSaving, setFormSaving] = useState(false);
    // 来自 ModelsPage 的状态（供 ModelConfigDialog 使用）
    const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
    ```

  - 数据加载 — `loadAll()` 合并两个 API 请求:

    ```typescript
    const loadAll = useCallback(async () => {
      setLoading(true);
      try {
        const [providersData, modelConfigData] = await Promise.all([
          (async () => {
            const data = await apiListProviders();
            const modelsMap: Record<string, ProviderModel[]> = {};
            await Promise.all(data.map(async (p) => {
              try {
                const detail = await apiGetProvider(p.id);
                modelsMap[p.id] = detail.models;
              } catch { modelsMap[p.id] = []; }
            }));
            return { providers: data, providerModels: modelsMap };
          })(),
          apiGetModels(),
        ]);
        setProviders(providersData.providers);
        setProviderModels(providersData.providerModels);
        setModelConfig(modelConfigData);
      } catch (e) {
        toast.error("加载数据失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setLoading(false);
      }
    }, []);
    ```

  - useEffect 调用: `useEffect(() => { loadAll(); }, [loadAll]);`
  - 服务商 CRUD 处理函数 — 从 ProvidersPage L361-L451 迁移，函数名保持不变:
    - `handleOpenCreate()`, `handleOpenEdit(provider)`, `handleSave()`
    - `handleTest(name)`, `handleAddFromTest(modelId)`
    - `handleDelete(name)`, `confirmDelete()`
    - `handleBatchDelete()`, `confirmBatchDelete()`
  - 注意: `handleSave` 内的 `loadProviders()` 调用改为 `loadAll()`；`confirmDelete` 同理

- [x] 编写 JSX 渲染部分
  - 位置: ModelsPage 组件函数的 return 语句
  - 加载骨架屏 — 从 ProvidersPage L453-L468 复制，标题改为 "模型管理"
  - 主体结构:

    ```tsx
    <div className="p-6 space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">模型管理</h2>
        <div className="flex items-center gap-2">
          <ModelConfigDialog
            currentModel={modelConfig?.current.model ?? null}
            currentSmallModel={modelConfig?.current.small_model ?? null}
            available={modelConfig?.available ?? []}
          />
          <Button onClick={handleOpenCreate}>新建服务商</Button>
        </div>
      </div>

      {/* 服务商 DataTable */}
      <DataTable<ProviderInfo>
        columns={columns}
        data={providers}
        searchable
        searchPlaceholder="搜索服务商..."
        selectable
        onSelectionChange={setSelected}
        rowKey={(row) => row.id}
        defaultExpandAll
        expandableRow={(row) => (
          <ModelSubrow
            providerId={row.id}
            models={providerModels[row.id] ?? []}
            onModelChange={(action, pid, mid) => {
              if (action === "delete" && mid) {
                setProviderModels((prev) => ({ ...prev, [pid]: (prev[pid] ?? []).filter((m) => m.id !== mid) }));
                setProviders((prev) => prev.map((p) => p.id === pid ? { ...p, modelCount: Math.max(0, p.modelCount - 1) } : p));
              } else if (action === "save") { loadAll(); }
            }}
          />
        )}
        actions={(row) => (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => handleTest(row.id)} disabled={testing === row.id}>
              {testing === row.id ? "测试中..." : "测试连接"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
            <Button size="sm" variant="destructive" onClick={() => handleDelete(row.id)}>删除</Button>
          </div>
        )}
      />

      {/* 批量操作栏 */}
      {selected.length > 0 && (
        <BatchActionBar selectedCount={selected.length} onClear={() => setSelected([])}
          actions={[{ label: "批量删除", variant: "destructive", onClick: handleBatchDelete }]} />
      )}

      {/* 服务商新建/编辑 Dialog */}
      <FormDialog open={dialogOpen} onOpenChange={setDialogOpen}
        title={editingProvider ? "编辑服务商" : "新建服务商"} onSubmit={handleSave} loading={formSaving}>
        {/* 从 ProvidersPage L522-L560 复制表单内容 */}
      </FormDialog>

      {/* 删除确认 Dialog */}
      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
        title="确认删除" description={`确定要删除服务商 "${deleteTarget}" 吗？`}
        variant="destructive" onConfirm={confirmDelete} />
      <ConfirmDialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}
        title="批量删除确认" description={`确定要删除选中的 ${selected.length} 个服务商吗？`}
        variant="destructive" onConfirm={confirmBatchDelete} />

      {/* 测试连接结果 Dialog */}
      <Dialog open={!!testResult} onOpenChange={() => setTestResult(null)}>
        {/* 从 ProvidersPage L567-L608 复制测试结果 Dialog 内容 */}
      </Dialog>
    </div>
    ```

- [x] 定义 DataTable 的 columns 配置
  - 位置: ModelsPage 组件函数内，`return` 之前
  - 复用 ProvidersPage L343-L359 的 columns 定义:

    ```typescript
    const columns: Column<ProviderInfo>[] = [
      { key: "id", header: "ID", sortable: true, filterable: true },
      { key: "name", header: "名称", sortable: true },
      { key: "npm", header: "NPM 包", render: (row) => {
        const opt = NPM_OPTIONS.find((o) => o.npm === row.npm);
        return opt ? opt.label : (row.npm || "—");
      }},
      { key: "keyHint", header: "API Key", render: (row) => row.keyHint || "—" },
      { key: "baseURL", header: "Base URL" },
      { key: "configured", header: "状态", filterable: true, render: (row) => <StatusBadge status={row.configured ? "configured" : "unconfigured"} /> },
      { key: "modelCount", header: "模型数", sortable: true },
    ];
    ```

- [x] 更新 `config-providers-page.test.ts` 的导入路径
  - 位置: `web/src/__tests__/config-providers-page.test.ts` L2
  - 将 `import { validateProviderForm, buildProviderPayload } from "../pages/ProvidersPage";` 改为 `import { validateProviderForm, buildProviderPayload } from "../pages/ModelsPage";`
  - 原因: `validateProviderForm` 和 `buildProviderPayload` 已迁移到 ModelsPage，ProvidersPage 在 Task 5 中将被删除

- [x] 为合并后的导出函数运行既有单元测试验证
  - 测试文件: `web/src/__tests__/config-models-page.test.ts` 和 `web/src/__tests__/config-providers-page.test.ts`
  - 运行命令: `bun test web/src/__tests__/config-models-page.test.ts web/src/__tests__/config-providers-page.test.ts`
  - 预期: 所有测试通过（`getModelUsageStatus`、`validateProviderForm`、`buildProviderPayload` 三个函数的行为不变）

**检查步骤:**

- [x] 验证 ModelsPage 导出所有必要的函数
  - `grep -n "export function" web/src/pages/ModelsPage.tsx`
  - 预期: 包含 `getModelUsageStatus`、`validateProviderForm`、`buildProviderPayload`、`ModelsPage` 四个导出
- [x] 验证 ModelConfigDialog 组件被引用
  - `grep -n "ModelConfigDialog" web/src/pages/ModelsPage.tsx`
  - 预期: 出现 import 声明和 JSX 使用
- [x] 验证 defaultExpandAll prop 被传入
  - `grep -n "defaultExpandAll" web/src/pages/ModelsPage.tsx`
  - 预期: 出现在 `<DataTable>` 的 props 中
- [x] 验证测试导入路径已更新
  - `grep "from.*ModelsPage" web/src/__tests__/config-providers-page.test.ts`
  - 预期: 导入路径为 `"../pages/ModelsPage"`
- [x] 运行全部相关测试
  - `bun test web/src/__tests__/config-models-page.test.ts web/src/__tests__/config-providers-page.test.ts`
  - 预期: 所有测试通过

---

### Task 4: 路由/侧边栏清理

**背景:**
合并后"服务商"不再作为独立页面存在，其功能已迁移到"模型"页面（Task 3）。需要从 App.tsx 中移除所有 providers 相关的路由配置、侧边栏入口和类型定义，确保 `/code/providers` 不再可访问。
本 Task 在 Task 3 完成后执行，Task 5 负责删除 ProvidersPage 源文件。

**涉及文件:**

- 修改: `web/src/App.tsx`
- 修改: `web/src/__tests__/config-routing.test.ts`

**执行步骤:**

- [x] 删除 ProvidersPage 的 lazy import 语句
  - 位置: `web/src/App.tsx` L21
  - 删除整行: `const ProvidersPage = lazy(() => import("./pages/ProvidersPage").then((m) => ({ default: m.ProvidersPage })));`

- [x] 从 lucide-react import 中移除 `Cloud` 图标
  - 位置: `web/src/App.tsx` L9-L17 import 语句
  - `Cloud` 图标仅在 providers sidebar item 中使用，移除后不再需要
  - 将 `Cloud,` 从 import 列表中删除

- [x] 从 `parseConfigView` 函数的 configViews 数组中移除 `"providers"`
  - 位置: `web/src/App.tsx` L27
  - 将 `const configViews = ["providers", "models", "agents", "skills"];` 改为 `const configViews = ["models", "agents", "skills"];`

- [x] 从 `ViewId` 类型中移除 `"providers"`
  - 位置: `web/src/App.tsx` L32
  - 将 `type ViewId = "dashboard" | "session" | "apikeys" | "login" | "providers" | "models" | "agents" | "skills";` 改为 `type ViewId = "dashboard" | "session" | "apikeys" | "login" | "models" | "agents" | "skills";`

- [x] 从 `parseRoute` 回调中的 configViews 数组移除 `"providers"`
  - 位置: `web/src/App.tsx` L43
  - 将 `const configViews = ["providers", "models", "agents", "skills"];` 改为 `const configViews = ["models", "agents", "skills"];`

- [x] 从 `footerItems` 中删除 providers sidebar item
  - 位置: `web/src/App.tsx` L128-L133
  - 删除整个对象:

    ```typescript
    {
      id: "providers",
      label: "服务商",
      icon: <Cloud className="h-4 w-4" />,
      active: activeView === "providers",
      onClick: () => navigateToConfig("providers"),
    },
    ```

- [x] 从 `pageTitle` 的 titles 映射中移除 providers 条目
  - 位置: `web/src/App.tsx` L166
  - 将 `const titles: Record<string, string> = { providers: "服务商", models: "模型", agents: "Agent", skills: "技能" };` 改为 `const titles: Record<string, string> = { models: "模型", agents: "Agent", skills: "技能" };`

- [x] 从路由匹配中移除 ProvidersPage 渲染分支
  - 位置: `web/src/App.tsx` L204-L206
  - 将:

    ```tsx
    configView === "providers" ? (
      <ProvidersPage />
    ) : configView === "models" ? (
    ```

  - 改为:

    ```tsx
    configView === "models" ? (
    ```

- [x] 更新路由测试文件中 providers 相关测试用例
  - 位置: `web/src/__tests__/config-routing.test.ts` L5-L7
  - 将:

    ```typescript
    test("/code/providers → providers", () => {
      expect(parseConfigView("/code/providers")).toBe("providers");
    });
    ```

  - 改为:

    ```typescript
    test("/code/providers → null (已移除)", () => {
      expect(parseConfigView("/code/providers")).toBeNull();
    });
    ```

  - 原因: providers 不再是有效的 config view，`/code/providers` 应返回 null

- [x] 为路由清理结果运行单元测试
  - 测试文件: `web/src/__tests__/config-routing.test.ts`
  - 运行命令: `bun test web/src/__tests__/config-routing.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 App.tsx 中不再引用 ProvidersPage
  - `grep -n "ProvidersPage" web/src/App.tsx`
  - 预期: 无匹配结果
- [x] 验证 App.tsx 中不再引用 Cloud 图标
  - `grep -n "Cloud" web/src/App.tsx`
  - 预期: 无匹配结果
- [x] 验证 configViews 不包含 providers
  - `grep -n "providers" web/src/App.tsx`
  - 预期: 无匹配结果
- [x] 运行路由测试
  - `bun test web/src/__tests__/config-routing.test.ts`
  - 预期: 所有测试通过

---

### Task 5: 删除 ProvidersPage + 测试迁移

**背景:**
ProvidersPage.tsx 中的所有逻辑（导出函数、内部组件、常量）已在 Task 3 中迁移到 ModelsPage.tsx，App.tsx 中的路由和侧边栏配置已在 Task 4 中清理。ProvidersPage.tsx 文件现在是孤立的，没有任何活跃引用，可以安全删除。
本 Task 是清理工作的收尾，确保项目目录中不存在废弃代码，且迁移后的测试路径正确。

**涉及文件:**

- 删除: `web/src/pages/ProvidersPage.tsx`
- 修改: `web/src/__tests__/config-providers-page.test.ts`（Task 3 步骤中已更新导入路径，本 Task 做最终确认）

**执行步骤:**

- [x] 确认 `config-providers-page.test.ts` 的导入路径已在 Task 3 中更新
  - 执行: `grep "from.*ModelsPage" web/src/__tests__/config-providers-page.test.ts`
  - 预期: 导入路径为 `"../pages/ModelsPage"`（Task 3 已完成此更新）

- [x] 删除 `ProvidersPage.tsx` 文件
  - 位置: `web/src/pages/ProvidersPage.tsx`
  - 执行: `rm web/src/pages/ProvidersPage.tsx`
  - 原因: 该文件所有逻辑已迁移，不再有任何活跃引用

- [x] Grep 确认项目中无 ProvidersPage 残留引用
  - 执行: `grep -rn "ProvidersPage" web/src/ --include="*.ts" --include="*.tsx"`
  - 预期: 无匹配结果（App.tsx 已在 Task 4 中清理，测试文件已由 Task 3 更新导入路径）

- [x] 为迁移后的函数运行单元测试验证
  - 测试文件: `web/src/__tests__/config-providers-page.test.ts`
  - 测试场景（已有，无需新增）:
    - `validateProviderForm("")` → `"名称不能为空"`
    - `validateProviderForm("openai", false)` → `null`
    - `validateProviderForm("a".repeat(65), false)` → `"名称长度须在 1-64 字符之间"`
    - `buildProviderPayload("key123", "", "", "")` → `{ apiKey: "key123" }`
    - `buildProviderPayload("", "http://api.test.com", "@ai-sdk/openai-compatible", "MyProvider")` → 含 baseURL/npm/name 的对象
    - `buildProviderPayload("", "", "", "")` → `{}`
  - 运行命令: `bun test web/src/__tests__/config-providers-page.test.ts`
  - 预期: 所有测试通过，函数行为与迁移前一致

**检查步骤:**

- [x] 验证 ProvidersPage.tsx 已删除
  - `ls web/src/pages/ProvidersPage.tsx 2>&1`
  - 预期: "No such file or directory"
- [x] 验证项目中无 ProvidersPage 引用
  - `grep -rn "ProvidersPage" web/src/ --include="*.ts" --include="*.tsx"`
  - 预期: 无匹配结果
- [x] 验证测试导入路径正确
  - `grep "from.*ModelsPage" web/src/__tests__/config-providers-page.test.ts`
  - 预期: 导入路径为 `"../pages/ModelsPage"`
- [x] 运行测试
  - `bun test web/src/__tests__/config-providers-page.test.ts`
  - 预期: 所有测试通过

---

### Task 6: Provider-Model 合并 验收

**前置条件:**

- 启动命令: `bun run dev:web`
- 所有 Task 1-5 已按顺序执行完毕
- 测试数据: 至少存在一个已配置的服务商（可通过 UI 新建或 API 创建）

**端到端验证:**

1. ~~运行完整测试套件确保无回归~~ ✅
   - `bun test web/src/__tests__/ 2>&1 | tail -10`
   - 预期: 全部测试通过，无失败
   - 失败排查: 检查各 Task 的测试步骤，逐一运行隔离定位

2. ~~验证前端构建无错误~~ ✅
   - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5`
   - 预期: 构建成功，无 TypeScript 编译错误
   - 失败排查: 检查 import 路径、类型定义是否完整（Task 3/4）

3. ~~验证侧边栏不再显示"服务商"入口~~ ✅
   - `grep -n "providers" web/src/App.tsx`
   - 预期: 无匹配结果（providers 路由和侧边栏入口已移除）
   - 失败排查: 检查 Task 4 路由清理是否完整

4. ~~验证 `/code/providers` 路由不可访问~~ ✅
   - `bun test web/src/__tests__/config-routing.test.ts`
   - 预期: `/code/providers → null` 测试通过
   - 失败排查: 检查 Task 4 中 parseConfigView 的 configViews 数组

5. ~~验证 ModelsPage 导出所有必要函数~~ ✅
   - `grep -n "export function" web/src/pages/ModelsPage.tsx`
   - 预期: 包含 `getModelUsageStatus`、`validateProviderForm`、`buildProviderPayload`、`ModelsPage` 四个导出
   - 失败排查: 检查 Task 3 迁移步骤

6. ~~验证 DataTable defaultExpandAll 属性存在~~ ✅
   - `grep -n "defaultExpandAll" web/components/config/DataTable.tsx`
   - 预期: 出现在接口定义、参数解构、初始化逻辑中
   - 失败排查: 检查 Task 1

7. ~~验证 ProvidersPage.tsx 已删除~~ ✅
   - `ls web/src/pages/ProvidersPage.tsx 2>&1`
   - 预期: "No such file or directory"
   - 失败排查: 检查 Task 5

8. ~~验证无 ProvidersPage 残留引用~~ ✅
   - `grep -rn "ProvidersPage" web/src/ --include="*.ts" --include="*.tsx"`
   - 预期: 无匹配结果
   - 失败排查: 检查 Task 4（App.tsx）和 Task 5（测试文件）
