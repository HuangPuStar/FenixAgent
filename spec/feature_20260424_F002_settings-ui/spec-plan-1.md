# Settings UI 执行计划（一）：基础设施与共享组件

**目标:** 为 4 个配置模块（Providers/Models/Agents/Skills）的前端管理页面搭建基础设施，包括依赖安装、API 对接层、共享 UI 组件和路由入口。

**技术栈:** React 19 + TypeScript + Vite + shadcn/ui + sonner + react-markdown + bun:test

**设计文档:** spec/feature_20260424_F002_settings-ui/spec-design.md

## 改动总览

本计划覆盖 Settings UI 的基础设施层：Task 0 验证环境就绪，Task 1 安装前端依赖（sonner/react-markdown）并定义类型，Task 2 扩展 API Client 对接后端 4 个配置模块，Task 3-4 构建共享 DataTable 及辅助组件，Task 5 改造 Sidebar 与路由使 4 个页面入口生效。后续 spec-plan-2.md 的 4 个页面模块（Task 6-9）全部依赖本计划产出。

---

### Task 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**

- [ ] 验证 bun 可用
  - 运行: `bun --version`
  - 预期: 输出 bun 版本号
- [ ] 验证前端构建工具可用
  - 运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web`
  - 预期: 构建成功，无错误

**检查步骤:**

- [ ] 前端构建无错误
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5`
  - 预期: 输出包含 "built in" 且无 error
- [ ] 测试框架可用
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/api-client.test.ts 2>&1 | tail -5`
  - 预期: 测试框架正常运行

---

### Task 1: 依赖安装与基础设施

**背景:**
本 Task 为整个 Settings UI 功能安装必需的前端依赖包，在 App 根组件中注册全局 Toast 容器，并定义 4 个配置模块的 TypeScript 类型接口。这是后续所有 Task 的基础——API Client（Task 2）需要类型定义，共享组件（Task 3-4）需要 Toast 提示能力，4 个页面模块（Task 6-9）需要 Toaster 全局实例。
**修改原因:** 当前项目未安装 sonner（Toast 通知库）和 react-markdown（Markdown 渲染库），也没有配置模块的 TypeScript 类型定义。App.tsx 中未挂载 Toaster 全局组件。

**涉及文件:**

- 修改: `package.json`（添加 sonner、react-markdown 依赖）
- 修改: `web/src/App.tsx`（添加 Toaster 全局组件）
- 新建: `web/src/types/config.ts`（配置模块类型定义）

**执行步骤:**

- [ ] 安装 sonner 和 react-markdown 依赖
  - 位置: 项目根目录
  - 运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun add sonner react-markdown`
  - 原因: spec-design.md 要求使用 sonner 处理 Toast 通知，react-markdown 用于 Skills 页面 Markdown 预览

- [ ] 在 App.tsx 中添加 Toaster 全局组件
  - 位置: `web/src/App.tsx` 文件顶部导入区域（~L1-L12）
  - 新增导入: `import { Toaster } from "sonner";`
  - 位置: `web/src/App.tsx` 的 `<ThemeProvider>` 包裹内（~L126），在 `<AppShell>` 之后、`</ThemeProvider>` 之前追加:

    ```tsx
    <Toaster richColors position="top-right" />
    ```

  - 原因: Toaster 需要挂载在 App 根节点，所有页面才能调用 `toast()` 函数

- [ ] 创建配置模块类型定义文件
  - 新建文件: `web/src/types/config.ts`
  - 内容：定义 4 个模块的 TypeScript 接口，与后端 API 响应结构对齐

    ```typescript
    // === Providers ===
    export interface ProviderInfo {
      name: string;
      configured: boolean;
      keyHint: string | null;
      baseURL: string;
    }

    export interface ProviderDetail {
      name: string;
      keyHint: string | null;
      [key: string]: unknown;
    }

    // === Models ===
    export interface ModelEntry {
      id: string;
      provider: string;
      label: string;
    }

    export interface ModelConfig {
      current: {
        model: string | null;
        small_model: string | null;
      };
      available: ModelEntry[];
    }

    // === Agents ===
    export interface AgentInfo {
      name: string;
      builtIn: boolean;
      model: string | null;
      mode: string | null;
    }

    export interface AgentDetail {
      name: string;
      builtIn: boolean;
      model: string | null;
      prompt: string | null;
      tools: string[] | null;
      steps: number | null;
      mode: string | null;
      permission: unknown;
    }

    // === Skills ===
    export interface SkillInfo {
      name: string;
      enabled: boolean;
      description: string;
      path: string;
    }

    export interface SkillDetail {
      name: string;
      description: string;
      content: string;
      enabled: boolean;
      path: string;
      metadata: Record<string, string>;
    }

    // === 通用 API 响应 ===
    export interface ApiResponse<T> {
      success: boolean;
      data?: T;
      error?: { code: string; message: string };
    }
    ```

  - 原因: 为 Task 2 的 API Client 和 Task 6-9 的页面提供类型安全保障

- [ ] 为类型定义编写单元测试
  - 测试文件: `web/src/__tests__/config-types.test.ts`
  - 测试场景:
    - 类型编译检查: 导入所有类型接口，创建符合接口的对象字面量，验证 TypeScript 编译通过
    - ApiResponse 成功响应结构: `{ success: true, data: { name: "test" } }` → `response.success === true`
    - ApiResponse 错误响应结构: `{ success: false, error: { code: "NOT_FOUND", message: "Not found" } }` → `response.error.code === "NOT_FOUND"`
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-types.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] sonner 和 react-markdown 已安装
  - `cd /Users/konghayao/code/pazhou/remote-control-server && ls node_modules/sonner/package.json node_modules/react-markdown/package.json`
  - 预期: 两个文件均存在
- [ ] App.tsx 包含 Toaster 组件
  - `grep -n "Toaster" /Users/konghayao/code/pazhou/remote-control-server/web/src/App.tsx`
  - 预期: 匹配到 import 行和使用行
- [ ] 类型文件已创建
  - `test -f /Users/konghayao/code/pazhou/remote-control-server/web/src/types/config.ts && echo "OK"`
  - 预期: 输出 OK
- [ ] 前端构建通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -3`
  - 预期: 构建成功，无错误

---

### Task 2: API Client 配置层

**背景:**
本 Task 在现有 API Client 中新增 4 个配置模块的请求函数，使前端页面能通过统一接口调用后端 `/web/config/{module}` 的各个 action。API Client 采用统一的 `api<T>(method, path, body)` 基础函数，所有配置请求通过 POST 发送 `{ action, name?, data? }` 结构体。Task 6-9 的 4 个页面全部依赖本 Task 的 API 函数。
**修改原因:** 当前 `web/src/api/client.ts` 只有 Session、Environment、Control、API Keys 相关函数，无配置模块函数。

**涉及文件:**

- 修改: `web/src/api/client.ts`

**执行步骤:**

- [ ] 在 client.ts 末尾新增配置模块 API 函数
  - 位置: `web/src/api/client.ts`（~L104，在 `apiUpdateApiKeyLabel` 函数之后）
  - 添加导入类型: `import type { ProviderInfo, ProviderDetail, ModelConfig, ModelEntry, AgentInfo, AgentDetail, SkillInfo, SkillDetail, ApiResponse } from "../types/config";`
  - 新增通用配置请求函数:

    ```typescript
    // --- Config ---

    async function apiConfigAction<T>(
      module: 'providers' | 'models' | 'agents' | 'skills',
      action: string,
      payload?: Record<string, unknown>
    ): Promise<T> {
      const res = await api<ApiResponse<T>>("POST", `/web/config/${module}`, { action, ...payload });
      if (!res.success && res.error) {
        throw new Error(res.error.message);
      }
      return res.data as T;
    }
    ```

  - 新增 Providers 模块函数（5 个）:

    ```typescript
    export function apiListProviders() {
      return apiConfigAction<{ providers: ProviderInfo[] }>("providers", "list").then(d => d.providers);
    }
    export function apiGetProvider(name: string) {
      return apiConfigAction<ProviderDetail>("providers", "get", { name });
    }
    export function apiSetProvider(name: string, data: Record<string, unknown>) {
      return apiConfigAction<{ name: string; keyHint: string | null }>("providers", "set", { name, data });
    }
    export function apiTestProvider(name: string) {
      return apiConfigAction<{ models: string[] }>("providers", "test", { name });
    }
    export function apiDeleteProvider(name: string) {
      return apiConfigAction<null>("providers", "delete", { name });
    }
    ```

  - 新增 Models 模块函数（3 个）:

    ```typescript
    export function apiGetModels() {
      return apiConfigAction<ModelConfig>("models", "get");
    }
    export function apiSetModels(data: { model?: string; small_model?: string }) {
      return apiConfigAction<{ model: string | null; small_model: string | null }>("models", "set", { data });
    }
    export function apiRefreshModels() {
      return apiConfigAction<{ count: number }>("models", "refresh");
    }
    ```

  - 新增 Agents 模块函数（6 个）:

    ```typescript
    export function apiListAgents() {
      return apiConfigAction<{ default_agent: string | null; agents: AgentInfo[] }>("agents", "list");
    }
    export function apiGetAgent(name: string) {
      return apiConfigAction<AgentDetail>("agents", "get", { name });
    }
    export function apiSetAgent(name: string, data: Record<string, unknown>) {
      return apiConfigAction<{ name: string }>("agents", "set", { name, data });
    }
    export function apiCreateAgent(name: string, data: Record<string, unknown>) {
      return apiConfigAction<{ name: string }>("agents", "create", { name, data });
    }
    export function apiDeleteAgent(name: string) {
      return apiConfigAction<null>("agents", "delete", { name });
    }
    export function apiSetDefaultAgent(name: string) {
      return apiConfigAction<{ default_agent: string }>("agents", "set_default", { name });
    }
    ```

  - 新增 Skills 模块函数（6 个）:

    ```typescript
    export function apiListSkills() {
      return apiConfigAction<{ skills: SkillInfo[] }>("skills", "list").then(d => d.skills);
    }
    export function apiGetSkill(name: string) {
      return apiConfigAction<SkillDetail>("skills", "get", { name });
    }
    export function apiSetSkill(name: string, data: { description: string; content: string; metadata?: Record<string, string> }) {
      return apiConfigAction<{ name: string; enabled: boolean }>("skills", "set", { name, data });
    }
    export function apiDeleteSkill(name: string) {
      return apiConfigAction<null>("skills", "delete", { name });
    }
    export function apiEnableSkill(name: string) {
      return apiConfigAction<{ name: string; enabled: boolean }>("skills", "enable", { name });
    }
    export function apiDisableSkill(name: string) {
      return apiConfigAction<{ name: string; enabled: boolean }>("skills", "disable", { name });
    }
    ```

- [ ] 为配置 API 函数编写单元测试
  - 测试文件: `web/src/__tests__/config-api-client.test.ts`
  - 复用现有 `api-client.test.ts` 的 fetch mock 模式（全局 fetch mock + fetchMock 状态对象）
  - 测试场景:
    - apiListProviders: mock 成功响应 `{ success: true, data: { providers: [...] } }` → 返回 providers 数组
    - apiSetProvider: mock 成功响应 → 验证 POST body 包含 `action: "set"`, `name`, `data`
    - apiTestProvider: mock 成功响应 `{ models: ["gpt-4"] }` → 返回模型列表
    - apiGetModels: mock 成功响应 → 验证返回 ModelConfig 结构
    - apiCreateAgent: mock 成功响应 → 验证 POST body 包含 `action: "create"`
    - apiDeleteSkill: mock 成功响应 → 验证 POST body 包含 `action: "delete"`
    - 错误处理: mock `{ success: false, error: { code: "NOT_FOUND", message: "Not found" } }` → 抛出 Error
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-api-client.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] client.ts 包含所有配置函数
  - `grep -c "export function api" /Users/konghayao/code/pazhou/remote-control-server/web/src/api/client.ts`
  - 预期: 输出 ≥ 20（原有函数 + 新增 20 个配置函数）
- [ ] 前端构建通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -3`
  - 预期: 构建成功，无错误

---

### Task 3: 共享组件 DataTable

**背景:**
本 Task 实现泛型 DataTable 组件，为 4 个配置模块页面（Task 6-9）提供统一的列表视图。DataTable 支持泛型列配置、客户端搜索/筛选/排序、分页和行选择，是整个 Settings UI 的核心共享组件。所有页面均基于此组件构建列表。
**修改原因:** 当前项目无 DataTable 组件。需要基于 shadcn/ui 的 Table 组件构建一个灵活的泛型数据表格。

**涉及文件:**

- 新建: `web/components/config/DataTable.tsx`
- 新建: `web/components/config/index.ts`

**执行步骤:**

- [ ] 创建 DataTable 泛型组件
  - 新建文件: `web/components/config/DataTable.tsx`
  - 核心接口设计:

    ```typescript
    export interface Column<T> {
      key: string;                    // 数据字段名
      header: string;                 // 列标题
      sortable?: boolean;             // 是否可排序
      filterable?: boolean;           // 是否可筛选
      render?: (row: T) => React.ReactNode; // 自定义渲染
    }

    interface DataTableProps<T> {
      columns: Column<T>[];
      data: T[];
      searchable?: boolean;           // 启用搜索
      searchPlaceholder?: string;
      selectable?: boolean;           // 启用行选择
      onSelectionChange?: (selected: T[]) => void;
      actions?: (row: T) => React.ReactNode; // 行操作列渲染
      emptyMessage?: string;
      pageSize?: number;              // 每页行数，默认 10
    }
    ```

  - 实现要点:
    - 使用 `useState` 管理搜索词、排序列/方向、筛选条件、当前页码、已选行集合
    - 搜索: 遍历所有 `filterable` 列的值进行不区分大小写的子串匹配
    - 排序: 根据 `sortable` 列的值进行升序/降序排列，支持 string/number 类型自动比较
    - 分页: 根据 `pageSize`（默认 10）切分数据，底部显示"第 X-Y 条，共 Z 条"和翻页按钮
    - 行选择: 通过 Checkbox（`web/components/ui/input.tsx` type=checkbox）切换，维护 `Set<number>`（行索引）或 `Set<string>`（按 key 字段），通过 `onSelectionChange` 回调传出
    - 空状态: 数据为空时渲染居中文字 `emptyMessage`（默认 "暂无数据"）
  - UI 布局:

    ```
    ┌─ 搜索框 (Input) ─────────────────────────────┐
    ├─ Table Header ────────────────────────────────┤
    │ [✓] │ 列1 (↑) │ 列2 (↓) │ 列3 │ 操作        │
    │ [✓] │ ...      │ ...      │ ... │ [按钮组]    │
    ├─ 分页: < 1 2 3 >  第1-10条，共25条 ──────────┤
    └───────────────────────────────────────────────┘
    ```

  - 样式: 使用 Tailwind CSS，表格使用 `w-full text-sm`，表头使用 `text-left font-medium text-muted-foreground`，行使用 `border-b hover:bg-muted/50`

- [ ] 创建 config 组件索引文件
  - 新建文件: `web/components/config/index.ts`
  - 初始导出: `export { DataTable } from "./DataTable"; export type { Column } from "./DataTable";`

- [ ] 为 DataTable 编写单元测试
  - 测试文件: `web/src/__tests__/config-datatable.test.ts`
  - 由于是 React 组件，使用 bun:test + 手动渲染验证逻辑（测试 hooks 辅助函数的纯逻辑）
  - 提取排序/筛选/分页的纯逻辑为独立函数并测试:

    ```typescript
    // 在 DataTable.tsx 中导出用于测试的纯函数
    export function filterData<T>(data: T[], columns: Column<T>[], search: string): T[]
    export function sortData<T>(data: T[], key: string, dir: "asc" | "desc"): T[]
    export function paginateData<T>(data: T[], page: number, size: number): { items: T[]; total: number }
    ```

  - 测试场景:
    - filterData: 搜索 "test" → 过滤出 name 包含 "test" 的行
    - filterData: 搜索为空 → 返回全部数据
    - sortData: 按 name 升序 → 正确排序
    - sortData: 按 name 降序 → 反序
    - paginateData: 25 条数据，page=1, size=10 → 返回 10 条，total=25
    - paginateData: 5 条数据，page=1, size=10 → 返回 5 条，total=5
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-datatable.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] DataTable 组件文件存在
  - `test -f /Users/konghayao/code/pazhou/remote-control-server/web/components/config/DataTable.tsx && echo "OK"`
  - 预期: 输出 OK
- [ ] DataTable 导出 filterData、sortData、paginateData 纯函数
  - `grep "export function" /Users/konghayao/code/pazhou/remote-control-server/web/components/config/DataTable.tsx`
  - 预期: 匹配到 3 个纯函数导出
- [ ] 前端构建通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -3`
  - 预期: 构建成功

---

### Task 4: 共享辅助组件

**背景:**
本 Task 实现 5 个共享辅助组件，为 Task 6-9 的页面提供统一的交互模式：ConfirmDialog 用于危险操作二次确认，FormDialog 用于表单弹窗容器，BatchActionBar 用于批量操作浮动工具条，StatusBadge 用于状态标签展示，EmptyState 用于空状态占位。这些组件确保 4 个页面的交互体验一致性。
**修改原因:** 当前项目无这些共享组件，需要基于 shadcn/ui 组件构建。

**涉及文件:**

- 新建: `web/components/config/ConfirmDialog.tsx`
- 新建: `web/components/config/FormDialog.tsx`
- 新建: `web/components/config/BatchActionBar.tsx`
- 新建: `web/components/config/StatusBadge.tsx`
- 新建: `web/components/config/EmptyState.tsx`
- 修改: `web/components/config/index.ts`（添加新组件导出）

**执行步骤:**

- [ ] 创建 ConfirmDialog 组件
  - 新建文件: `web/components/config/ConfirmDialog.tsx`
  - 接口:

    ```typescript
    interface ConfirmDialogProps {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      title: string;
      description: string;
      confirmLabel?: string;    // 默认 "确认"
      cancelLabel?: string;     // 默认 "取消"
      variant?: "default" | "destructive"; // 确认按钮样式
      onConfirm: () => void;
      loading?: boolean;
    }
    ```

  - 实现: 基于 `Dialog` + `DialogContent` + `DialogHeader` + `DialogTitle` + `DialogDescription` + `DialogFooter`（来自 `@/components/ui/dialog`）
  - 确认按钮使用 `variant="destructive"` 时显示红色警告样式

- [ ] 创建 FormDialog 组件
  - 新建文件: `web/components/config/FormDialog.tsx`
  - 接口:

    ```typescript
    interface FormDialogProps {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      title: string;
      children: React.ReactNode;  // 表单内容
      onSubmit: () => void;
      submitLabel?: string;       // 默认 "保存"
      loading?: boolean;
      width?: string;             // 默认 "sm:max-w-lg"
    }
    ```

  - 实现: 基于 `Dialog` + `DialogContent`，包裹 `<form onSubmit>` 结构，底部包含取消和提交按钮

- [ ] 创建 BatchActionBar 组件
  - 新建文件: `web/components/config/BatchActionBar.tsx`
  - 接口:

    ```typescript
    interface BatchActionBarProps {
      selectedCount: number;
      actions: Array<{
        label: string;
        icon?: React.ReactNode;
        variant?: "default" | "destructive";
        onClick: () => void;
      }>;
      onClear: () => void;
    }
    ```

  - 实现: 固定在底部的浮动条（`fixed bottom-4 left-1/2 -translate-x-1/2`），基于 `Card` 组件，左侧显示 "已选择 N 项" + `Badge`，右侧排列操作 `Button`

- [ ] 创建 StatusBadge 组件
  - 新建文件: `web/components/config/StatusBadge.tsx`
  - 接口:

    ```typescript
    interface StatusBadgeProps {
      status: string;
      colorMap?: Record<string, "default" | "secondary" | "destructive" | "outline">;
    }
    ```

  - 实现: 基于 `Badge` 组件，内置默认颜色映射:
    - "configured" / "enabled" / "已配置" / "已启用" → green: `bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300`
    - "unconfigured" / "disabled" / "未配置" / "已禁用" → gray: `variant="secondary"`
    - "builtIn" / "内置" → blue: `bg-blue-100 text-blue-700`
    - "custom" / "自定义" → `variant="outline"`

- [ ] 创建 EmptyState 组件
  - 新建文件: `web/components/config/EmptyState.tsx`
  - 接口:

    ```typescript
    interface EmptyStateProps {
      icon?: React.ReactNode;
      title: string;
      description?: string;
      action?: {
        label: string;
        onClick: () => void;
      };
    }
    ```

  - 实现: 居中的 `Card` 容器，包含图标、标题文字、描述文字和操作按钮

- [ ] 更新 config 组件索引文件
  - 位置: `web/components/config/index.ts`
  - 追加导出:

    ```typescript
    export { ConfirmDialog } from "./ConfirmDialog";
    export { FormDialog } from "./FormDialog";
    export { BatchActionBar } from "./BatchActionBar";
    export { StatusBadge } from "./StatusBadge";
    export { EmptyState } from "./EmptyState";
    ```

- [ ] 为辅助组件的纯逻辑编写单元测试
  - 测试文件: `web/src/__tests__/config-helpers.test.ts`
  - 提取 StatusBadge 的颜色映射逻辑为导出函数 `getBadgeVariant`:

    ```typescript
    export function getBadgeVariant(status: string): string
    ```

  - 测试场景:
    - getBadgeVariant("configured") → "green"
    - getBadgeVariant("disabled") → "secondary"
    - getBadgeVariant("builtIn") → "blue"
    - getBadgeVariant("unknown") → "outline"
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-helpers.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 5 个辅助组件文件存在
  - `ls /Users/konghayao/code/pazhou/remote-control-server/web/components/config/ | grep -E "Confirm|Form|Batch|Status|Empty"`
  - 预期: 输出 5 个文件名
- [ ] index.ts 导出所有组件
  - `grep -c "export" /Users/konghayao/code/pazhou/remote-control-server/web/components/config/index.ts`
  - 预期: ≥ 6（DataTable + 5 个辅助组件）
- [ ] 前端构建通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -3`
  - 预期: 构建成功

---

### Task 5: Sidebar 改造与路由

**背景:**
本 Task 改造 Sidebar 导航和路由系统，为 4 个配置模块页面添加入口。在现有 Sidebar 的 API Keys 入口下方、退出按钮上方新增 4 个平铺入口（服务商、模型、Agent、技能），使用 Separator 分隔。在 App.tsx 中扩展 ViewId 类型和路由匹配逻辑，4 个新页面使用 React.lazy 懒加载。
**修改原因:** 当前 ViewId 类型仅包含 dashboard/session/apikeys/login，Sidebar 仅有 Dashboard/Session/API Keys/Logout 入口，无配置模块入口。

**涉及文件:**

- 修改: `web/src/App.tsx`

**执行步骤:**

- [ ] 扩展 ViewId 类型
  - 位置: `web/src/App.tsx`（~L17）
  - 将 `type ViewId = "dashboard" | "session" | "apikeys" | "login";` 改为:

    ```typescript
    type ViewId = "dashboard" | "session" | "apikeys" | "login" | "providers" | "models" | "agents" | "skills";
    ```

- [ ] 新增 lucide-react 图标导入
  - 位置: `web/src/App.tsx`（~L8-L12 导入区域）
  - 追加导入: `Cloud, Cpu, Bot, Wrench` 四个图标
  - 修改后导入:

    ```typescript
    import {
      LayoutDashboard,
      MessageSquare,
      KeyRound,
      LogOut,
      Cloud,
      Cpu,
      Bot,
      Wrench,
    } from "lucide-react";
    ```

- [ ] 新增 4 个页面懒加载导入
  - 位置: `web/src/App.tsx`（~L14-L15，在现有 lazy 导入之后）
  - 追加:

    ```typescript
    const ProvidersPage = lazy(() => import("./pages/ProvidersPage").then((m) => ({ default: m.ProvidersPage })));
    const ModelsPage = lazy(() => import("./pages/ModelsPage").then((m) => ({ default: m.ModelsPage })));
    const AgentsPage = lazy(() => import("./pages/AgentsPage").then((m) => ({ default: m.AgentsPage })));
    const SkillsPage = lazy(() => import("./pages/SkillsPage").then((m) => ({ default: m.SkillsPage })));
    ```

- [ ] 新增配置页面路由状态
  - 位置: `web/src/App.tsx` App 函数内（~L21，在现有 useState 声明区域之后）
  - 新增状态:

    ```typescript
    const [configView, setConfigView] = useState<string | null>(null);
    ```

  - 新增导航回调:

    ```typescript
    const navigateToConfig = useCallback((view: string) => {
      window.history.pushState(null, "", `/code/${view}`);
      setConfigView(view);
      setShowApiKeys(false);
      setCurrentSessionId(null);
    }, []);
    ```

- [ ] 修改 parseRoute 匹配配置页面路由
  - 位置: `web/src/App.tsx` parseRoute 回调（~L26-L33）
  - 修改匹配逻辑，在现有 session 路由匹配之后追加配置路由检测:

    ```typescript
    const parseRoute = useCallback(() => {
      const path = window.location.pathname;
      const configViews = ["providers", "models", "agents", "skills"];
      // 去掉 /code/ 前缀后的路径段
      const segment = path.replace(/^\/code\/?/, "").split("/")[0];
      if (configViews.includes(segment)) {
        setConfigView(segment);
        setCurrentSessionId(null);
      } else {
        setConfigView(null);
        const match = path.match(/^\/code\/([^/]+)/);
        if (match && match[1] && match[1] !== "login" && match[1] !== "api-keys" && !configViews.includes(match[1])) {
          setCurrentSessionId(match[1]);
        } else {
          setCurrentSessionId(null);
        }
      }
    }, []);
    ```

- [ ] 修改 activeView 计算逻辑
  - 位置: `web/src/App.tsx`（~L81-L83）
  - 将:

    ```typescript
    const activeView: ViewId =
      showApiKeys ? "apikeys" :
      currentSessionId ? "session" : "dashboard";
    ```

    改为:

    ```typescript
    const activeView: ViewId =
      showApiKeys ? "apikeys" :
      configView ? configView as ViewId :
      currentSessionId ? "session" : "dashboard";
    ```

- [ ] 修改 navItems 构造，添加配置模块入口
  - 位置: `web/src/App.tsx`（~L85-L101 navItems useMemo）
  - 在 navItems 数组中追加 Separator 和 4 个配置入口:

    ```typescript
    const navItems: SidebarItem[] = useMemo(() => [
      {
        id: "dashboard",
        label: "仪表盘",
        icon: <LayoutDashboard className="h-4 w-4" />,
        active: activeView === "dashboard",
        onClick: navigateToDashboard,
      },
      ...(currentSessionId && !showApiKeys && !configView ? [{
        id: "session",
        label: "会话",
        icon: <MessageSquare className="h-4 w-4" />,
        active: true,
        badge: "ACP",
        onClick: () => {},
      }] : []),
    ], [activeView, currentSessionId, configView, navigateToDashboard]);
    ```

- [ ] 修改 footerItems 构造，添加配置模块入口
  - 位置: `web/src/App.tsx`（~L103-L117 footerItems useMemo）
  - 在 footerItems 数组中，API Keys 和 Logout 之间插入 4 个配置入口:

    ```typescript
    const footerItems: SidebarItem[] = useMemo(() => [
      {
        id: "apikeys",
        label: "API 密钥",
        icon: <KeyRound className="h-4 w-4" />,
        active: activeView === "apikeys",
        onClick: navigateToApiKeys,
      },
      // 配置模块入口
      {
        id: "providers",
        label: "服务商",
        icon: <Cloud className="h-4 w-4" />,
        active: activeView === "providers",
        onClick: () => navigateToConfig("providers"),
      },
      {
        id: "models",
        label: "模型",
        icon: <Cpu className="h-4 w-4" />,
        active: activeView === "models",
        onClick: () => navigateToConfig("models"),
      },
      {
        id: "agents",
        label: "Agent",
        icon: <Bot className="h-4 w-4" />,
        active: activeView === "agents",
        onClick: () => navigateToConfig("agents"),
      },
      {
        id: "skills",
        label: "技能",
        icon: <Wrench className="h-4 w-4" />,
        active: activeView === "skills",
        onClick: () => navigateToConfig("skills"),
      },
      {
        id: "logout",
        label: userEmail,
        icon: <LogOut className="h-4 w-4" />,
        onClick: handleLogout,
      },
    ], [activeView, userEmail, navigateToApiKeys, navigateToConfig, handleLogout]);
    ```

- [ ] 修改 pageTitle 计算逻辑
  - 位置: `web/src/App.tsx`（~L119-L123 pageTitle useMemo）
  - 追加配置页面的标题映射:

    ```typescript
    const pageTitle = useMemo(() => {
      if (showApiKeys) return "API 密钥";
      if (configView) {
        const titles: Record<string, string> = { providers: "服务商", models: "模型", agents: "Agent", skills: "技能" };
        return titles[configView] || "配置";
      }
      if (currentSessionId) return "会话";
      return "仪表盘";
    }, [showApiKeys, configView, currentSessionId]);
    ```

- [ ] 修改渲染区域，添加配置页面路由分发
  - 位置: `web/src/App.tsx` Suspense 内部（~L136-L143）
  - 在现有条件渲染中追加配置页面分支:

    ```tsx
    {showApiKeys ? (
      <ApiKeyManager onBack={navigateToDashboard} />
    ) : configView === "providers" ? (
      <ProvidersPage />
    ) : configView === "models" ? (
      <ModelsPage />
    ) : configView === "agents" ? (
      <AgentsPage />
    ) : configView === "skills" ? (
      <SkillsPage />
    ) : currentSessionId ? (
      <SessionDetail key={currentSessionId} sessionId={currentSessionId} />
    ) : (
      <Dashboard onNavigateSession={navigateToSession} />
    )}
    ```

- [ ] 确认 Sidebar 分隔线无需额外修改
  - 位置: `web/src/components/shell/Sidebar.tsx`（~L64-L68，nav 区域和 footer 区域之间）
  - 经代码确认，Sidebar 组件的 nav 区域（~L64）和 footer 区域（~L72）之间已有 `border-t` 样式分隔线，无需额外添加 Separator 组件
  - 本步骤为信息确认，不执行代码修改
  - 原因: 避免不必要的 Sidebar 改动

- [ ] 为路由逻辑编写单元测试
  - 测试文件: `web/src/__tests__/config-routing.test.ts`
  - 提取路由解析函数为独立导出函数用于测试:

    ```typescript
    // 在 App.tsx 中导出用于测试
    export function parseConfigView(pathname: string): string | null {
      const configViews = ["providers", "models", "agents", "skills"];
      const segment = pathname.replace(/^\/code\/?/, "").split("/")[0];
      return configViews.includes(segment) ? segment : null;
    }
    ```

  - 测试场景:
    - parseConfigView("/code/providers") → "providers"
    - parseConfigView("/code/models") → "models"
    - parseConfigView("/code/agents") → "agents"
    - parseConfigView("/code/skills") → "skills"
    - parseConfigView("/code/") → null
    - parseConfigView("/code/some-session-id") → null
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-routing.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] App.tsx 包含 4 个新图标导入
  - `grep -c "Cloud\|Cpu\|Bot\|Wrench" /Users/konghayao/code/pazhou/remote-control-server/web/src/App.tsx`
  - 预期: ≥ 4
- [ ] App.tsx 包含 4 个懒加载导入
  - `grep "lazy" /Users/konghayao/code/pazhou/remote-control-server/web/src/App.tsx | grep -c "Page"`
  - 预期: ≥ 6（原有 2 个 + 新增 4 个）
- [ ] ViewId 类型包含配置视图
  - `grep "providers.*models.*agents.*skills" /Users/konghayao/code/pazhou/remote-control-server/web/src/App.tsx`
  - 预期: 匹配到 ViewId 类型定义
- [ ] 前端构建通过（此时 4 个页面文件尚不存在，构建会报错——这是预期的，Task 6-9 创建页面文件后构建将通过）
  - 此步骤在 Task 6 完成后验证

---

### Task [5 验收]: 基础设施层验收

**前置条件:**

- 所有 Task 1-5 的执行步骤已完成
- 后端服务运行中: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev`

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/ 2>&1 | tail -10`
   - 预期: 所有测试通过
   - 失败排查: 检查各 Task 的测试步骤

2. 验证前端构建通过
   - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5`
   - 预期: 构建成功（需 Task 6-9 的页面文件已创建后此步骤才能通过）
   - 失败排查: 检查 Task 5 的懒加载导入是否与页面文件名匹配

3. 验证 sonner Toaster 已挂载
   - `grep "Toaster" /Users/konghayao/code/pazhou/remote-control-server/web/src/App.tsx`
   - 预期: 匹配到导入和使用
   - 失败排查: 检查 Task 1

4. 验证 API Client 包含所有配置函数
   - `grep "export function api.*Provider\|Model\|Agent\|Skill" /Users/konghayao/code/pazhou/remote-control-server/web/src/api/client.ts | wc -l`
   - 预期: ≥ 20
   - 失败排查: 检查 Task 2

5. 验证共享组件文件完整
   - `ls /Users/konghayao/code/pazhou/remote-control-server/web/components/config/ | wc -l`
   - 预期: ≥ 7（index.ts + DataTable + 5 个辅助组件）
   - 失败排查: 检查 Task 3-4
