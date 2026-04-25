# Settings UI 管理页面执行计划

**目标:** 为 Providers、Models、Agents、Skills 四个配置模块实现完整的 Web UI 管理页面

**技术栈:** React 19 + TypeScript + Vite + shadcn/ui (Radix) + Tailwind CSS + bun:test

**设计文档:** spec/feature_20260424_F002_settings-ui/spec-design.md

## 改动总览

本次改动涉及前端 Web UI 层，共修改 2 个核心文件（App.tsx 路由 + Sidebar.tsx 分隔线）、修改 1 个 API 层文件（client.ts 新增 19 个配置 API 函数）、新建 7 个共享组件（web/components/config/）、新建 4 个模块页面（Providers/Models/Agents/Skills）及 5 个测试文件。
Task 1（API Client）和 Task 3（共享组件）是 Task 4-7 页面的前置依赖；Task 2（Sidebar+路由）独立于其他 Task，可与 Task 1/3 并行。关键设计决策：配置 API 使用 `apiConfigRaw<T>()` 统一检查 `success` 字段（后端业务错误返回 HTTP 200 + `{success:false}`）；DataTable 使用纯函数导出排序/筛选/分页逻辑以支持独立单元测试；Markdown 编辑器使用 react-markdown 轻量方案而非重量级编辑器库。

---

### Task 0: 环境准备

**背景:**
确保前端构建、测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**

- [ ] 验证构建工具可用
  - 位置: 项目根目录
  - `cd web && npx vite build 2>&1 | tail -3`
  - 确认 Vite 构建成功

- [ ] 验证测试工具可用
  - 位置: 项目根目录
  - `cd web && bun test src/__tests__/utils.test.ts 2>&1 | tail -5`
  - 确认 bun:test 测试框架可用

**检查步骤:**

- [ ] 构建命令执行成功
  - `cd web && npx vite build 2>&1 | grep -c "built in"`
  - 预期: 输出 ≥ 1

- [ ] 测试命令可用
  - `cd web && bun test src/__tests__/utils.test.ts 2>&1 | grep -c "pass"`
  - 预期: 输出 ≥ 1，无配置错误

---

### Task 1: API Client 配置请求函数

**背景:**
后端 F001 已实现 4 个配置模块的 POST 端点（`/web/config/{providers,models,agents,skills}`），每个端点通过 `action` 字段路由到具体操作。现有 `api<T>()` 函数仅检查 HTTP 状态码，但配置 API 的业务错误（如 NOT_FOUND）以 HTTP 200 + `{ success: false }` 返回，需要新增一层响应检查。
本 Task 为 4 个模块页面（Task 4-7）提供所有数据请求函数。

**涉及文件:**

- 修改: `web/src/api/client.ts`

**执行步骤:**

- [ ] 在 `web/src/api/client.ts` 末尾（`apiUpdateApiKeyLabel` 函数之后，约 L104）新增配置 API 类型定义和通用请求函数
  - 位置: `web/src/api/client.ts` (~L104, 在 `apiUpdateApiKeyLabel` 函数之后)
  - 新增配置 API 统一响应类型:

    ```typescript
    // --- Config API ---

    interface ConfigResponse<T> {
      success: boolean;
      data?: T;
      error?: { code: string; message: string };
    }

    /**
     * 配置 API 通用请求函数。
     * 与 api<T>() 的区别：配置端点在 HTTP 200 时可能返回 success:false 的业务错误，
     * 需额外检查 success 字段并抛出 Error。
     */
    async function apiConfigRaw<T>(
      module: "providers" | "models" | "agents" | "skills",
      body: Record<string, unknown>
    ): Promise<T> {
      const result = await api<ConfigResponse<T>>("POST", `/web/config/${module}`, body);
      if (!result.success) {
        throw new Error(result.error?.message || `${module} action failed`);
      }
      return result.data as T;
    }
    ```

  - 原因: 配置端点的业务错误（如 NOT_FOUND、VALIDATION_ERROR）返回 HTTP 200 + `{ success: false, error: {...} }`，不同于现有 `api()` 仅靠 `res.ok` 判断的模式

- [ ] 新增 Providers 模块的类型定义和 API 函数（紧接 `apiConfigRaw` 之后）
  - 位置: `web/src/api/client.ts` (在 `apiConfigRaw` 之后)
  - 新增类型:

    ```typescript
    // --- Providers ---

    export interface ProviderInfo {
      name: string;
      configured: boolean;
      keyHint: string | null;
      baseURL: string;
    }

    export interface ProviderDetail extends Record<string, unknown> {
      name: string;
      keyHint: string | null;
    }

    export function apiListProviders() {
      return apiConfigRaw<{ providers: ProviderInfo[] }>("providers", { action: "list" })
        .then((d) => d.providers);
    }

    export function apiGetProvider(name: string) {
      return apiConfigRaw<ProviderDetail>("providers", { action: "get", name });
    }

    export function apiSetProvider(name: string, data: Record<string, unknown>) {
      return apiConfigRaw<{ name: string; keyHint: string | null }>("providers", { action: "set", name, data });
    }

    export function apiTestProvider(name: string) {
      return apiConfigRaw<{ models: string[] }>("providers", { action: "test", name });
    }

    export function apiDeleteProvider(name: string) {
      return apiConfigRaw<null>("providers", { action: "delete", name });
    }
    ```

- [ ] 新增 Models 模块的类型定义和 API 函数
  - 位置: `web/src/api/client.ts` (在 Providers 函数之后)
  - 新增类型:

    ```typescript
    // --- Models ---

    export interface ModelEntry {
      id: string;
      provider: string;
      label: string;
    }

    export interface ModelsConfig {
      current: { model: string | null; small_model: string | null };
      available: ModelEntry[];
    }

    export function apiGetModels() {
      return apiConfigRaw<ModelsConfig>("models", { action: "get" });
    }

    export function apiSetModels(data: { model?: string; small_model?: string }) {
      return apiConfigRaw<{ model: string | null; small_model: string | null }>("models", { action: "set", data });
    }

    export function apiRefreshModels() {
      return apiConfigRaw<{ count: number }>("models", { action: "refresh" });
    }
    ```

- [ ] 新增 Agents 模块的类型定义和 API 函数
  - 位置: `web/src/api/client.ts` (在 Models 函数之后)
  - 新增类型:

    ```typescript
    // --- Agents ---

    export interface AgentInfo {
      name: string;
      builtIn: boolean;
      model: string | null;
      mode: string | null;
    }

    export interface AgentDetail extends AgentInfo {
      prompt: string | null;
      tools: string[] | null;
      steps: number | null;
      permission: unknown;
    }

    export interface AgentsListResult {
      default_agent: string | null;
      agents: AgentInfo[];
    }

    export function apiListAgents() {
      return apiConfigRaw<AgentsListResult>("agents", { action: "list" });
    }

    export function apiGetAgent(name: string) {
      return apiConfigRaw<AgentDetail>("agents", { action: "get", name });
    }

    export function apiCreateAgent(name: string, data: Record<string, unknown>) {
      return apiConfigRaw<{ name: string }>("agents", { action: "create", name, data });
    }

    export function apiSetAgent(name: string, data: Record<string, unknown>) {
      return apiConfigRaw<{ name: string }>("agents", { action: "set", name, data });
    }

    export function apiDeleteAgent(name: string) {
      return apiConfigRaw<null>("agents", { action: "delete", name });
    }

    export function apiSetDefaultAgent(name: string) {
      return apiConfigRaw<{ default_agent: string }>("agents", { action: "set_default", name });
    }
    ```

- [ ] 新增 Skills 模块的类型定义和 API 函数
  - 位置: `web/src/api/client.ts` (在 Agents 函数之后)
  - 新增类型:

    ```typescript
    // --- Skills ---

    export interface SkillInfo {
      name: string;
      description: string;
      content: string;
      enabled: boolean;
      metadata?: Record<string, string>;
    }

    export function apiListSkills() {
      return apiConfigRaw<{ skills: SkillInfo[] }>("skills", { action: "list" })
        .then((d) => d.skills);
    }

    export function apiGetSkill(name: string) {
      return apiConfigRaw<SkillInfo>("skills", { action: "get", name });
    }

    export function apiSetSkill(name: string, data: { description: string; content: string; metadata?: Record<string, string> }) {
      return apiConfigRaw<{ name: string; enabled: boolean }>("skills", { action: "set", name, data });
    }

    export function apiDeleteSkill(name: string) {
      return apiConfigRaw<null>("skills", { action: "delete", name });
    }

    export function apiEnableSkill(name: string) {
      return apiConfigRaw<{ name: string; enabled: boolean }>("skills", { action: "enable", name });
    }

    export function apiDisableSkill(name: string) {
      return apiConfigRaw<{ name: string; enabled: boolean }>("skills", { action: "disable", name });
    }
    ```

- [ ] 为配置 API 客户端函数编写单元测试
  - 测试文件: `web/src/__tests__/config-api-client.test.ts`
  - 测试场景:
    - `apiConfigRaw` 在 `success: true` 时正确返回 data 字段: mock fetch 返回 `{ success: true, data: { providers: [] } }` → 调用 `apiListProviders()` → 返回 `[]`
    - `apiConfigRaw` 在 `success: false` 时抛出 Error: mock fetch 返回 `{ success: false, error: { code: "NOT_FOUND", message: "Provider 'x' not found" } }` → 调用 `apiGetProvider("x")` → 抛出 `Error("Provider 'x' not found")`
    - `apiListProviders` 发送正确的请求体: 调用后检查 `fetchMock.lastOpts.body` 包含 `{ action: "list" }`，`fetchMock.lastUrl` 为 `/web/config/providers`
    - `apiSetModels` 发送嵌套 data 结构: 调用 `apiSetModels({ model: "gpt-4" })` → body 为 `{ action: "set", data: { model: "gpt-4" } }`
    - `apiCreateAgent` 发送 name + data: 调用 `apiCreateAgent("my-agent", { mode: "primary" })` → body 包含 `{ action: "create", name: "my-agent", data: { mode: "primary" } }`
    - `apiSetSkill` 发送完整 data 对象: 调用后 body 包含 `{ action: "set", name: "skill1", data: { description: "...", content: "..." } }`
  - 运行命令: `cd web && bun test src/__tests__/config-api-client.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证新增函数正确导出
  - `grep -c "export function api" web/src/api/client.ts`
  - 预期: 输出 ≥ 19（原有 9 个 + 新增 10 个: apiListProviders, apiGetProvider, apiSetProvider, apiTestProvider, apiDeleteProvider, apiGetModels, apiSetModels, apiRefreshModels, apiListAgents, apiGetAgent, apiCreateAgent, apiSetAgent, apiDeleteAgent, apiSetDefaultAgent, apiListSkills, apiGetSkill, apiSetSkill, apiDeleteSkill, apiEnableSkill, apiDisableSkill）

- [ ] 验证新增类型正确导出
  - `grep -c "export interface" web/src/api/client.ts`
  - 预期: 输出 ≥ 7（原有 2 个 + 新增 ProviderInfo, ProviderDetail, ModelEntry, ModelsConfig, AgentInfo, AgentDetail, AgentsListResult, SkillInfo）

- [ ] 验证测试通过
  - `cd web && bun test src/__tests__/config-api-client.test.ts`
  - 预期: 所有测试通过，无失败

- [ ] 验证 TypeScript 编译无错误
  - `cd web && npx tsc --noEmit --skipLibCheck 2>&1 | tail -5`
  - 预期: 无错误输出

---

### Task 2: Sidebar 改造与路由扩展

**背景:**
当前 Sidebar 只有 Dashboard、Session、API Keys 三个入口，且 SidebarItem 接口不支持分隔线渲染。需要新增 4 个配置模块入口（服务商、模型、Agent、技能），并按要求在 API 密钥下方、退出上方插入 Separator 分隔线。
本 Task 的路由改造为 Task 4-7 的页面组件提供导航入口和 URL 映射。

**涉及文件:**

- 修改: `web/src/components/shell/Sidebar.tsx`
- 修改: `web/src/App.tsx`

**执行步骤:**

- [ ] 在 `SidebarItem` 接口中新增 `separator` 可选字段
  - 位置: `web/src/components/shell/Sidebar.tsx` (~L15-21, SidebarItem 接口定义)
  - 在接口末尾（`onClick` 之后）新增字段: `separator?: boolean;`
  - 完整接口变为:

    ```typescript
    export interface SidebarItem {
      id: string;
      label: string;
      icon: React.ReactNode;
      badge?: string;
      active?: boolean;
      onClick?: () => void;
      separator?: boolean;
    }
    ```

  - 原因: 需要在 Sidebar 导航列表中插入视觉分隔线，separator 标记该项为分隔线而非可点击按钮

- [ ] 在 Sidebar nav 区域添加 separator 渲染逻辑
  - 位置: `web/src/components/shell/Sidebar.tsx` (~L64-68, nav 区域 items.map)
  - 在文件顶部添加 Separator 导入: `import { Separator } from "../../components/ui/separator";`
  - 将 items.map 内的渲染逻辑改为条件分支:

    ```tsx
    {items.map((item) =>
      item.separator ? (
        <Separator key={item.id} className="my-2" />
      ) : (
        <SidebarNavItem key={item.id} item={item} collapsed={collapsed} />
      )
    )}
    ```

  - 原因: separator 项渲染为水平分隔线，非 separator 项照常渲染为可点击按钮

- [ ] 在 Sidebar footer 区域添加 separator 渲染逻辑
  - 位置: `web/src/components/shell/Sidebar.tsx` (~L71-76, footer 区域 footerItems.map)
  - 将 footerItems.map 内的渲染逻辑改为同样的条件分支:

    ```tsx
    {footerItems.map((item) =>
      item.separator ? (
        <Separator key={item.id} className="my-2" />
      ) : (
        <SidebarNavItem key={item.id} item={item} collapsed={collapsed} />
      )
    )}
    ```

- [ ] 在 App.tsx 中新增 4 个 lucide-react 图标导入和 4 个页面懒加载
  - 位置: `web/src/App.tsx` (~L8-12, lucide-react 导入)
  - 将导入语句改为:

    ```typescript
    import {
      LayoutDashboard,
      MessageSquare,
      KeyRound,
      Cloud,
      Cpu,
      Bot,
      Wrench,
      LogOut,
    } from "lucide-react";
    ```

  - 位置: `web/src/App.tsx` (~L14-15, lazy 加载语句之后)
  - 新增 4 个懒加载:

    ```typescript
    const ProvidersPage = lazy(() => import("./pages/ProvidersPage").then((m) => ({ default: m.ProvidersPage })));
    const ModelsPage = lazy(() => import("./pages/ModelsPage").then((m) => ({ default: m.ModelsPage })));
    const AgentsPage = lazy(() => import("./pages/AgentsPage").then((m) => ({ default: m.AgentsPage })));
    const SkillsPage = lazy(() => import("./pages/SkillsPage").then((m) => ({ default: m.SkillsPage })));
    ```

- [ ] 扩展 ViewId 类型
  - 位置: `web/src/App.tsx` (~L17, type ViewId 定义)
  - 将类型改为:

    ```typescript
    type ViewId = "dashboard" | "session" | "apikeys" | "login" | "providers" | "models" | "agents" | "skills";
    ```

- [ ] 新增 configView 状态和 CONFIG_VIEWS 常量
  - 位置: `web/src/App.tsx` (~L22, 在 showApiKeys state 之后)
  - 新增:

    ```typescript
    const [configView, setConfigView] = useState<string | null>(null);
    ```

  - 位置: `web/src/App.tsx` (在 parseRoute 函数之前)
  - 新增常量:

    ```typescript
    const CONFIG_VIEWS = new Set(["providers", "models", "agents", "skills"]);
    ```

- [ ] 改造 parseRoute 函数以识别配置模块路由
  - 位置: `web/src/App.tsx` (~L25-33, parseRoute 函数体)
  - 将函数体替换为:

    ```typescript
    const parseRoute = useCallback(() => {
      const path = window.location.pathname;
      const match = path.match(/^\/code\/([^/]+)/);
      if (match && match[1]) {
        const segment = match[1];
        if (CONFIG_VIEWS.has(segment)) {
          setConfigView(segment);
          setCurrentSessionId(null);
          setShowApiKeys(false);
        } else if (segment !== "login" && segment !== "api-keys") {
          setCurrentSessionId(segment);
          setConfigView(null);
          setShowApiKeys(false);
        }
      } else {
        setCurrentSessionId(null);
        setConfigView(null);
      }
    }, []);
    ```

- [ ] 新增 navigateToConfig 回调函数
  - 位置: `web/src/App.tsx` (~L56, 在 navigateToApiKeys 之后)
  - 新增:

    ```typescript
    const navigateToConfig = useCallback((view: string) => {
      window.history.pushState(null, "", `/code/${view}`);
      setConfigView(view);
      setCurrentSessionId(null);
      setShowApiKeys(false);
    }, []);
    ```

- [ ] 更新 navigateToDashboard 回调以清除 configView
  - 位置: `web/src/App.tsx` (~L46-50, navigateToDashboard 函数体)
  - 在函数体内 `setShowApiKeys(false);` 之后新增: `setConfigView(null);`

- [ ] 更新 activeView 计算逻辑
  - 位置: `web/src/App.tsx` (~L81-83, activeView 赋值)
  - 将逻辑改为:

    ```typescript
    const activeView: ViewId =
      showApiKeys ? "apikeys" :
      configView ? (configView as ViewId) :
      currentSessionId ? "session" : "dashboard";
    ```

- [ ] 重构 navItems 以包含 API 密钥、分隔线和 4 个配置入口
  - 位置: `web/src/App.tsx` (~L85-101, navItems useMemo)
  - 将整个 useMemo 替换为:

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
      {
        id: "apikeys",
        label: "API 密钥",
        icon: <KeyRound className="h-4 w-4" />,
        active: activeView === "apikeys",
        onClick: navigateToApiKeys,
      },
      { id: "sep-config", label: "", icon: <></>, separator: true },
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
    ], [activeView, currentSessionId, configView, showApiKeys, navigateToDashboard, navigateToApiKeys, navigateToConfig]);
    ```

- [ ] 简化 footerItems（仅保留退出登录，API 密钥已移至 navItems）
  - 位置: `web/src/App.tsx` (~L103-117, footerItems useMemo)
  - 将整个 useMemo 替换为:

    ```typescript
    const footerItems: SidebarItem[] = useMemo(() => [
      {
        id: "logout",
        label: userEmail,
        icon: <LogOut className="h-4 w-4" />,
        onClick: handleLogout,
      },
    ], [userEmail, handleLogout]);
    ```

- [ ] 更新 pageTitle 计算逻辑
  - 位置: `web/src/App.tsx` (~L119-123, pageTitle useMemo)
  - 将逻辑改为:

    ```typescript
    const pageTitle = useMemo(() => {
      if (showApiKeys) return "API 密钥";
      if (configView === "providers") return "服务商";
      if (configView === "models") return "模型";
      if (configView === "agents") return "Agent";
      if (configView === "skills") return "技能";
      if (currentSessionId) return "会话";
      return "仪表盘";
    }, [showApiKeys, configView, currentSessionId]);
    ```

- [ ] 更新 Suspense 内的条件渲染，新增 4 个配置页面的路由分支
  - 位置: `web/src/App.tsx` (~L133-144, Suspense 内的条件渲染)
  - 将条件渲染改为:

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

- [ ] 为路由解析逻辑编写单元测试
  - 测试文件: `web/src/__tests__/route-config.test.ts`
  - 测试场景:
    - CONFIG_VIEWS 集合包含 4 个配置视图名: 验证 `new Set(["providers", "models", "agents", "skills"])` 的 has 方法对每个值返回 true
    - 非 config 路径段不匹配: "dashboard"、"some-session-id"、"login" 不在 CONFIG_VIEWS 中
    - SidebarItem separator 字段类型正确: 构造 `{ id: "sep", label: "", icon: <></>, separator: true }` 不产生 TypeScript 类型错误
  - 运行命令: `cd web && bun test src/__tests__/route-config.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 Sidebar.tsx 正确导入和使用 Separator 组件
  - `grep -c "separator" web/src/components/shell/Sidebar.tsx`
  - 预期: 输出 ≥ 3（接口字段、nav 区域条件、footer 区域条件）

- [ ] 验证 App.tsx 新增了 4 个 lucide 图标导入
  - `grep -E "Cloud|Cpu|Bot|Wrench" web/src/App.tsx | wc -l`
  - 预期: 输出 ≥ 4

- [ ] 验证 App.tsx ViewId 类型包含所有配置视图
  - `grep "providers.*models.*agents.*skills" web/src/App.tsx`
  - 预期: ViewId 类型定义中包含 "providers" | "models" | "agents" | "skills"

- [ ] 验证 TypeScript 编译无错误
  - `cd web && npx tsc --noEmit --skipLibCheck 2>&1 | tail -5`
  - 预期: 无错误输出（4 个懒加载页面的 import 会因文件尚不存在报错，此检查在 Task 4-7 完成后通过）

- [ ] 验证 Vite 构建通过
  - `cd web && npx vite build 2>&1 | tail -5`
  - 预期: 构建成功（需 Task 4-7 页面文件存在后验证）

- [ ] 验证测试通过
  - `cd web && bun test src/__tests__/route-config.test.ts`
  - 预期: 所有测试通过

---

### Task 3: 共享 UI 组件

**背景:**
Task 4-7 的 4 个配置模块页面共享相同的数据展示和交互模式（表格、弹窗、确认框、批量操作、状态标签、空状态）。本 Task 将这些通用交互抽象为可复用组件，确保 4 个页面的交互一致性，避免重复代码。
本 Task 是 Task 4-7 的直接依赖，所有页面组件将引用本 Task 产出的 DataTable、FormDialog、ConfirmDialog 等。

**涉及文件:**

- 新建: `web/components/config/DataTable.tsx`
- 新建: `web/components/config/ConfirmDialog.tsx`
- 新建: `web/components/config/FormDialog.tsx`
- 新建: `web/components/config/BatchActionBar.tsx`
- 新建: `web/components/config/StatusBadge.tsx`
- 新建: `web/components/config/EmptyState.tsx`
- 新建: `web/components/config/index.ts`

**执行步骤:**

- [ ] 新建 `web/components/config/StatusBadge.tsx` — 状态标签组件
  - 位置: `web/components/config/StatusBadge.tsx`（新建文件）
  - 基于 `web/components/ui/badge.tsx` 的 Badge 组件构建
  - Props 接口:

    ```typescript
    import { Badge } from "../ui/badge";
    import { cn } from "../../src/lib/utils";

    type StatusVariant = "success" | "warning" | "error" | "default";

    interface StatusBadgeProps {
      variant?: StatusVariant;
      children: React.ReactNode;
      className?: string;
    }

    const variantClasses: Record<StatusVariant, string> = {
      success: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
      warning: "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
      error: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
      default: "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/30 dark:text-gray-400 dark:border-gray-800",
    };

    export function StatusBadge({ variant = "default", children, className }: StatusBadgeProps) {
      return (
        <Badge variant="outline" className={cn(variantClasses[variant], className)}>
          {children}
        </Badge>
      );
    }
    ```

- [ ] 新建 `web/components/config/EmptyState.tsx` — 空状态占位组件
  - 位置: `web/components/config/EmptyState.tsx`（新建文件）
  - 基于 `web/components/ui/card.tsx` 的 Card 组件和 `web/components/ui/button.tsx` 的 Button 组件构建
  - Props 接口:

    ```typescript
    import { Card, CardContent } from "../ui/card";
    import { Button } from "../ui/button";

    interface EmptyStateProps {
      title: string;
      description?: string;
      action?: { label: string; onClick: () => void };
    }

    export function EmptyState({ title, description, action }: EmptyStateProps) {
      return (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm font-medium text-text-primary">{title}</p>
            {description && (
              <p className="mt-1 text-xs text-text-muted">{description}</p>
            )}
            {action && (
              <Button variant="outline" size="sm" className="mt-4" onClick={action.onClick}>
                {action.label}
              </Button>
            )}
          </CardContent>
        </Card>
      );
    }
    ```

- [ ] 新建 `web/components/config/ConfirmDialog.tsx` — 危险操作二次确认弹窗
  - 位置: `web/components/config/ConfirmDialog.tsx`（新建文件）
  - 基于 `web/components/ui/dialog.tsx` 的 Dialog/DialogContent/DialogHeader/DialogTitle/DialogDescription/DialogFooter 组件构建
  - Props 接口:

    ```typescript
    import {
      Dialog, DialogContent, DialogHeader, DialogTitle,
      DialogDescription, DialogFooter,
    } from "../ui/dialog";
    import { Button } from "../ui/button";

    interface ConfirmDialogProps {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      title: string;
      description: string;
      confirmLabel?: string;
      cancelLabel?: string;
      variant?: "destructive" | "default";
      loading?: boolean;
      onConfirm: () => void;
    }

    export function ConfirmDialog({
      open, onOpenChange, title, description,
      confirmLabel = "确认", cancelLabel = "取消",
      variant = "destructive", loading = false, onConfirm,
    }: ConfirmDialogProps) {
      return (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                {cancelLabel}
              </Button>
              <Button
                variant={variant === "destructive" ? "destructive" : "default"}
                onClick={onConfirm}
                disabled={loading}
              >
                {loading ? "处理中..." : confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      );
    }
    ```

- [ ] 新建 `web/components/config/FormDialog.tsx` — 表单弹窗壳组件
  - 位置: `web/components/config/FormDialog.tsx`（新建文件）
  - 基于 `web/components/ui/dialog.tsx` 构建，包装 form 标签处理 submit 事件
  - Props 接口:

    ```typescript
    import {
      Dialog, DialogContent, DialogHeader, DialogTitle,
      DialogFooter,
    } from "../ui/dialog";
    import { Button } from "../ui/button";

    interface FormDialogProps {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      title: string;
      submitLabel?: string;
      cancelLabel?: string;
      loading?: boolean;
      onSubmit: () => void;
      children: React.ReactNode;
    }

    export function FormDialog({
      open, onOpenChange, title,
      submitLabel = "保存", cancelLabel = "取消",
      loading = false, onSubmit, children,
    }: FormDialogProps) {
      return (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="space-y-4">
              {children}
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => onOpenChange(false)} disabled={loading}>
                  {cancelLabel}
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? "保存中..." : submitLabel}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      );
    }
    ```

- [ ] 新建 `web/components/config/BatchActionBar.tsx` — 批量操作浮动工具条
  - 位置: `web/components/config/BatchActionBar.tsx`（新建文件）
  - 基于 `web/components/ui/card.tsx` 的 Card 和 `web/components/ui/badge.tsx` 的 Badge 构建
  - Props 接口:

    ```typescript
    import { Card } from "../ui/card";
    import { Badge } from "../ui/badge";
    import { Button } from "../ui/button";

    interface BatchAction {
      label: string;
      variant?: "destructive" | "default" | "outline";
      onClick: () => void;
      loading?: boolean;
    }

    interface BatchActionBarProps {
      selectedCount: number;
      actions: BatchAction[];
      onCancel: () => void;
    }

    export function BatchActionBar({ selectedCount, actions, onCancel }: BatchActionBarProps) {
      return (
        <Card className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-lg border px-4 py-2 shadow-lg">
          <Badge variant="secondary">已选 {selectedCount} 项</Badge>
          {actions.map((action, i) => (
            <Button
              key={i}
              variant={action.variant ?? "default"}
              size="sm"
              onClick={action.onClick}
              disabled={action.loading}
            >
              {action.label}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={onCancel}>取消选择</Button>
        </Card>
      );
    }
    ```

- [ ] 新建 `web/components/config/DataTable.tsx` — 泛型数据表格组件（核心共享组件）
  - 位置: `web/components/config/DataTable.tsx`（新建文件）
  - 基于 `web/components/ui/input.tsx` 的 Input、`web/components/ui/button.tsx` 的 Button 构建，使用原生 HTML table 元素（与 shadcn Table 组件一致的模式）
  - 完整组件定义:

    ```typescript
    import { useState, useMemo, useCallback } from "react";
    import { Input } from "../ui/input";
    import { Button } from "../ui/button";
    import { cn } from "../../src/lib/utils";

    // --- 类型定义 ---

    export interface Column<T> {
      id: string;
      header: string;
      /** 返回单元格渲染内容 */
      cell: (row: T) => React.ReactNode;
      /** 是否可排序 — 排序时使用 cell 的字符串化结果比较 */
      sortable?: boolean;
      /** 是否可筛选 — 启用后自动在工具栏生成筛选下拉 */
      filterable?: boolean;
      /** 自定义筛选选项（固定列表），不提供则从数据自动提取去重值 */
      filterOptions?: { label: string; value: string }[];
      /** 排序比较函数，不提供则按 cell 文本排序 */
      sortFn?: (a: T, b: T) => number;
    }

    interface DataTableProps<T> {
      columns: Column<T>[];
      data: T[];
      /** 行唯一标识字段名（从 row[keyField] 提取） */
      keyField: string;
      /** 是否启用搜索框 */
      searchable?: boolean;
      /** 搜索占位文字 */
      searchPlaceholder?: string;
      /** 每页条数，默认 10 */
      pageSize?: number;
      /** 是否启用行选择 */
      selectable?: boolean;
      /** 已选中行 ID 集合 */
      selectedIds?: Set<string>;
      /** 选中行变化回调 */
      onSelectionChange?: (ids: Set<string>) => void;
      /** 表格顶部的工具栏额外内容（如"新建"按钮） */
      toolbar?: React.ReactNode;
      /** 空状态文案 */
      emptyText?: string;
      /** 加载中状态 */
      loading?: boolean;
    }

    export function DataTable<T>({
      columns, data, keyField,
      searchable = true,
      searchPlaceholder = "搜索...",
      pageSize = 10,
      selectable = false,
      selectedIds,
      onSelectionChange,
      toolbar,
      emptyText = "暂无数据",
      loading = false,
    }: DataTableProps<T>) {
      // ... 完整实现见下方步骤
    }
    ```

  - DataTable 内部状态管理:
    - `search: string` — 搜索关键词
    - `filters: Record<string, string>` — 每个可筛选列的当前筛选值（列 id → 筛选值，空字符串表示不筛选）
    - `sortColumn: string | null` — 当前排序列 id
    - `sortDirection: "asc" | "desc"` — 排序方向
    - `currentPage: number` — 当前页码（从 1 开始）
  - DataTable 核心处理逻辑:

    ```typescript
    // 1. 搜索过滤：遍历所有列的 cell(row) 转字符串，匹配 search（不区分大小写）
    const filtered = useMemo(() => {
      if (!search) return data;
      const q = search.toLowerCase();
      return data.filter((row) =>
        columns.some((col) =>
          String(col.cell(row)).toLowerCase().includes(q)
        )
      );
    }, [data, search, columns]);

    // 2. 列筛选：对 filterable 列应用 filters[col.id]
    const afterFilter = useMemo(() => {
      let result = filtered;
      for (const col of columns) {
        if (!col.filterable) continue;
        const val = filters[col.id];
        if (!val) continue;
        result = result.filter((row) => String(col.cell(row)) === val);
      }
      return result;
    }, [filtered, columns, filters]);

    // 3. 排序
    const sorted = useMemo(() => {
      if (!sortColumn) return afterFilter;
      const col = columns.find((c) => c.id === sortColumn);
      if (!col) return afterFilter;
      return [...afterFilter].sort((a, b) => {
        if (col.sortFn) return col.sortFn(a, b);
        const va = String(col.cell(a)), vb = String(col.cell(b));
        return va.localeCompare(vb);
      }).map((row, i, arr) => {
        // 如果是降序则反转
        return sortDirection === "desc" ? arr[arr.length - 1 - i] : row;
      });
      // 实际实现用 sortDirection 判断正反序即可
    }, [afterFilter, sortColumn, sortDirection, columns]);

    // 4. 分页
    const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
    const pageData = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    ```

  - 工具栏渲染: 搜索输入框（searchable 为 true 时显示）+ 可筛选列的下拉 + toolbar props 插槽
  - 表头渲染: 列名 + 可排序列显示排序箭头按钮
  - 行选择: 首列 checkbox（selectable 为 true 时显示），表头全选 checkbox（半选状态使用 indeterminate）。选中行通过 `onSelectionChange` 回调传出，行 ID 通过 `row[keyField]` 提取
  - 分页控件: "上一页" / "第 X / N 页" / "下一页" + "共 M 条"
  - 原因: DataTable 是 4 个配置模块页面的核心展示组件，需支持完整的客户端搜索/筛选/排序/分页/行选择

- [ ] 新建 `web/components/config/index.ts` — 统一导出文件
  - 位置: `web/components/config/index.ts`（新建文件）
  - 内容:

    ```typescript
    export { DataTable, type Column } from "./DataTable";
    export { ConfirmDialog } from "./ConfirmDialog";
    export { FormDialog } from "./FormDialog";
    export { BatchActionBar, type BatchAction } from "./BatchActionBar";
    export { StatusBadge } from "./StatusBadge";
    export { EmptyState } from "./EmptyState";
    ```

- [ ] 为 DataTable 的核心排序/筛选/分页逻辑编写纯函数单元测试
  - 测试文件: `web/src/__tests__/config-datatable-utils.test.ts`
  - 由于 DataTable 的核心逻辑是纯数据处理（搜索、筛选、排序、分页），将提取出的逻辑函数独立导出测试
  - 在 `DataTable.tsx` 中同时导出 `filterData`、`sortData`、`paginateData` 三个纯函数:

    ```typescript
    // 导出的纯函数供测试使用
    export function filterData<T>(
      data: T[],
      columns: Column<T>[],
      search: string,
      filters: Record<string, string>
    ): T[] { ... }

    export function sortData<T>(
      data: T[],
      columns: Column<T>[],
      sortColumn: string | null,
      sortDirection: "asc" | "desc"
    ): T[] { ... }

    export function paginateData<T>(
      data: T[],
      currentPage: number,
      pageSize: number
    ): { page: T[]; totalPages: number; total: number } { ... }
    ```

  - 测试场景:
    - `filterData` 空搜索返回原数据: `filterData(data, cols, "", {})` → 原数据数组
    - `filterData` 按关键词过滤: 搜索 "alice" → 只返回 name 包含 "alice" 的行
    - `filterData` 按列筛选值过滤: `filters["status"] = "active"` → 只返回状态为 "active" 的行
    - `filterData` 搜索 + 筛选组合: 同时使用搜索和筛选 → 结果为两者交集
    - `sortData` 未指定排序列返回原数据: `sortColumn = null` → 原数组
    - `sortData` 按列升序排序: `sortColumn = "name", sortDirection = "asc"` → 按名称升序
    - `sortData` 按列降序排序: `sortColumn = "name", sortDirection = "desc"` → 按名称降序
    - `paginateData` 第 1 页: 25 条数据、每页 10 → page 长度 10，totalPages = 3
    - `paginateData` 最后一页: 第 3 页 → page 长度 5
    - `paginateData` 空数据: 空数组 → page 为空，totalPages = 0（或 1，取决于实现）
  - 运行命令: `cd web && bun test src/__tests__/config-datatable-utils.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 7 个新文件全部创建
  - `ls web/components/config/*.tsx web/components/config/*.ts | wc -l`
  - 预期: 输出 7

- [ ] 验证 index.ts 导出了所有组件
  - `grep -c "export" web/components/config/index.ts`
  - 预期: 输出 6（6 个组件导出）

- [ ] 验证 DataTable.tsx 包含泛型 Column 接口
  - `grep "interface Column" web/components/config/DataTable.tsx`
  - 预期: 输出包含 `interface Column<T>`

- [ ] 验证 DataTable.tsx 导出了纯函数
  - `grep "export function" web/components/config/DataTable.tsx | wc -l`
  - 预期: 输出 ≥ 4（DataTable 组件 + filterData + sortData + paginateData）

- [ ] 验证测试通过
  - `cd web && bun test src/__tests__/config-datatable-utils.test.ts`
  - 预期: 所有测试通过

- [ ] 验证 TypeScript 编译无错误
  - `cd web && npx tsc --noEmit --skipLibCheck 2>&1 | tail -5`
  - 预期: 无组件文件相关的类型错误

---

### Task 4: Providers 管理页面

**背景:**
实现服务商（Providers）配置的完整 CRUD 管理页面，用户可通过 Web UI 新增/编辑/删除服务商、测试 API 连接、查看模型列表。这是 4 个配置模块页面中的第一个，也是交互最复杂的一个（含测试连接流程和 API Key 安全处理）。
本 Task 依赖 Task 1 的 API 函数（apiListProviders 等 5 个）和 Task 3 的共享组件（DataTable、FormDialog、ConfirmDialog、BatchActionBar、StatusBadge、EmptyState）。

**涉及文件:**

- 新建: `web/src/pages/ProvidersPage.tsx`

**执行步骤:**

- [ ] 安装 sonner Toast 库（本项目当前未安装任何 Toast 库，所有模块页面共用）
  - 运行命令: `bun add sonner`
  - 原因: 设计文档要求 API 错误和操作反馈使用 Toast 通知，sonner 与 shadcn/ui 风格一致

- [ ] 创建 `web/src/pages/ProvidersPage.tsx`，实现完整的 Providers 管理页面
  - 位置: `web/src/pages/ProvidersPage.tsx`（新建文件）
  - 导入依赖:

    ```typescript
    import { useState, useEffect, useCallback } from "react";
    import { toast } from "sonner";
    import {
      apiListProviders,
      apiSetProvider,
      apiTestProvider,
      apiDeleteProvider,
      type ProviderInfo,
    } from "../api/client";
    import {
      DataTable,
      type Column,
      ConfirmDialog,
      FormDialog,
      BatchActionBar,
      StatusBadge,
      EmptyState,
    } from "@/components/config";
    import { Button } from "@/components/ui/button";
    import { Input } from "@/components/ui/input";
    import { Label } from "@/components/ui/label";
    import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
    import { Plus, Eye, EyeOff, Loader2, Plug } from "lucide-react";
    ```

  - 导出组件: `export function ProvidersPage()`（注意：使用命名导出，与 Task 2 中 lazy 加载的 `.then(m => ({ default: m.ProvidersPage }))` 匹配）

- [ ] 实现页面状态管理
  - 位置: `web/src/pages/ProvidersPage.tsx` — ProvidersPage 组件内部
  - 状态定义:

    ```typescript
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [loading, setLoading] = useState(true);
    // 表单弹窗
    const [formOpen, setFormOpen] = useState(false);
    const [editingProvider, setEditingProvider] = useState<ProviderInfo | null>(null);
    const [formName, setFormName] = useState("");
    const [formApiKey, setFormApiKey] = useState("");
    const [formBaseUrl, setFormBaseUrl] = useState("");
    const [formTimeout, setFormTimeout] = useState("");
    const [formSubmitting, setFormSubmitting] = useState(false);
    // API Key 显隐切换
    const [showApiKey, setShowApiKey] = useState(false);
    // 测试连接
    const [testingName, setTestingName] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<string[] | null>(null);
    const [testDialogOpen, setTestDialogOpen] = useState(false);
    // 批量操作
    const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleteTargets, setDeleteTargets] = useState<string[]>([]);
    ```

  - 数据加载函数:

    ```typescript
    const loadProviders = useCallback(async () => {
      try {
        const data = await apiListProviders();
        setProviders(data);
      } catch (e) {
        toast.error("加载服务商列表失败", { description: e instanceof Error ? e.message : "未知错误" });
      } finally {
        setLoading(false);
      }
    }, []);
    useEffect(() => { loadProviders(); }, [loadProviders]);
    ```

- [ ] 实现 DataTable 列配置
  - 位置: `web/src/pages/ProvidersPage.tsx` — ProvidersPage 组件内部
  - 列定义:

    ```typescript
    const columns: Column<ProviderInfo>[] = [
      {
        id: "name",
        header: "名称",
        sortable: true,
        filterable: true,
        cell: (row) => <span className="font-medium">{row.name}</span>,
      },
      {
        id: "keyHint",
        header: "API Key",
        cell: (row) => (
          <span className="font-mono text-xs text-text-muted">
            {row.keyHint ?? "—"}
          </span>
        ),
      },
      {
        id: "baseURL",
        header: "Base URL",
        cell: (row) => (
          <span className="text-xs text-text-muted truncate max-w-[200px] block">
            {row.baseURL}
          </span>
        ),
      },
      {
        id: "configured",
        header: "状态",
        filterable: true,
        cell: (row) => (
          <StatusBadge variant={row.configured ? "success" : "default"}>
            {row.configured ? "已配置" : "未配置"}
          </StatusBadge>
        ),
        filterOptions: [
          { label: "已配置", value: "true" },
          { label: "未配置", value: "false" },
        ],
        filterFn: (row, value) => String(row.configured) === value,
      },
      {
        id: "actions",
        header: "操作",
        cell: (row) => (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost" size="sm"
              onClick={() => handleTest(row.name)}
              disabled={testingName === row.name}
            >
              {testingName === row.name
                ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />测试中</>
                : <><Plug className="h-3 w-3 mr-1" />测试</>}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleEdit(row)}>编辑</Button>
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleDelete([row.name])}>删除</Button>
          </div>
        ),
      },
    ];
    ```

- [ ] 实现新建/编辑弹窗逻辑
  - 位置: `web/src/pages/ProvidersPage.tsx` — ProvidersPage 组件内部
  - 新建入口: 顶部"新增服务商"按钮，设置 editingProvider=null、清空表单、打开 formOpen
  - 编辑入口: 行操作"编辑"按钮，调用 apiGetProvider(name) 获取详情后填充表单，设置 editingProvider=row，打开 formOpen
  - 表单提交逻辑:

    ```typescript
    const handleFormSubmit = async () => {
      // 校验
      if (!formName.trim() || formName.trim().length > 64) {
        toast.error("名称为必填项，且不超过 64 字符");
        return;
      }
      setFormSubmitting(true);
      try {
        const data: Record<string, unknown> = {};
        if (formApiKey) data.apiKey = formApiKey;
        if (formBaseUrl) data.baseURL = formBaseUrl;
        if (formTimeout) data.timeout = parseInt(formTimeout, 10);
        await apiSetProvider(formName.trim(), data);
        toast.success(editingProvider ? "服务商已更新" : "服务商已创建");
        setFormOpen(false);
        await loadProviders();
      } catch (e) {
        toast.error("操作失败", { description: e instanceof Error ? e.message : "未知错误" });
      } finally {
        setFormSubmitting(false);
      }
    };
    ```

  - 弹窗 JSX:
    - FormDialog 组件包裹，title 为 "新建服务商" 或 "编辑服务商"
    - 名称 Input（编辑时 disabled，背景灰色）
    - API Key Input（type=password/showApiKey 切换 + Eye/EyeOff 图标切换按钮，placeholder="留空表示不修改"）
    - Base URL Input（placeholder="默认使用服务商 URL"）
    - Timeout Input（type=number, placeholder="单位 ms"）

- [ ] 实现测试连接流程
  - 位置: `web/src/pages/ProvidersPage.tsx` — ProvidersPage 组件内部
  - 逻辑:

    ```typescript
    const handleTest = async (name: string) => {
      setTestingName(name);
      try {
        const result = await apiTestProvider(name);
        setTestResult(result.models);
        setTestDialogOpen(true);
      } catch (e) {
        toast.error("测试连接失败", { description: e instanceof Error ? e.message : "未知错误" });
      } finally {
        setTestingName(null);
      }
    };
    ```

  - 测试结果 Dialog: 使用 Dialog 组件（非 FormDialog），标题"连接测试结果"，内容为模型列表（`<ul>` + `<li>` 渲染 testResult 数组），底部关闭按钮

- [ ] 实现批量删除和单行删除逻辑
  - 位置: `web/src/pages/ProvidersPage.tsx` — ProvidersPage 组件内部
  - handleDelete 函数: 设置 deleteTargets 数组、打开 ConfirmDialog
  - 确认后执行:

    ```typescript
    const confirmBatchDelete = async () => {
      try {
        await Promise.all(deleteTargets.map((name) => apiDeleteProvider(name)));
        toast.success(`已删除 ${deleteTargets.length} 个服务商`);
        setSelectedRows(new Set());
        await loadProviders();
      } catch (e) {
        toast.error("批量删除失败", { description: e instanceof Error ? e.message : "未知错误" });
      } finally {
        setConfirmDelete(false);
        setDeleteTargets([]);
      }
    };
    ```

  - BatchActionBar: 当 selectedRows.size > 0 时显示，显示已选数量 + "批量删除"按钮
  - ConfirmDialog: title="确认删除"，description="确定要删除选中的 {N} 个服务商吗？此操作不可逆。"

- [ ] 组装页面 JSX
  - 位置: `web/src/pages/ProvidersPage.tsx` — ProvidersPage 组件 return
  - 结构:

    ```tsx
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-text-primary">服务商管理</h1>
          <Button onClick={handleCreate}><Plus className="h-4 w-4 mr-1" />新增服务商</Button>
        </div>
        {loading ? <Loading/> : providers.length === 0 ? <EmptyState title="暂无服务商" description="点击上方按钮新增一个服务商配置" /> : (
          <>
            <DataTable columns={columns} data={providers} keyField="name"
              selectedIds={selectedRows} onSelectionChange={setSelectedRows} />
            {selectedRows.size > 0 && (
              <BatchActionBar
                selectedCount={selectedRows.size}
                actions={[{ label: "批量删除", variant: "destructive" as const, onClick: () => handleDelete(Array.from(selectedRows)) }]}
                onCancel={() => setSelectedRows(new Set())}
              />
            )}
          </>
        )}
        {/* FormDialog、ConfirmDialog、TestResult Dialog */}
      </div>
    </div>
    ```

- [ ] 为 Providers 页面的校验函数编写单元测试
  - 测试文件: `web/src/__tests__/providers-page.test.ts`
  - 测试场景:
    - `validateProviderName("abc")` → 有效: true
    - `validateProviderName("")` → 有效: false（空字符串）
    - `validateProviderName("a".repeat(65))` → 有效: false（超长）
    - `validateProviderName("valid-name")` → 有效: true
    - `buildProviderData({ apiKey: "sk-xxx", baseURL: "", timeout: "5000" })` → 返回 `{ apiKey: "sk-xxx", timeout: 5000 }`（空字段不包含）
    - `buildProviderData({ apiKey: "", baseURL: "", timeout: "" })` → 返回 `{}`（全部为空）
  - 说明: 将 `validateProviderName` 和 `buildProviderData` 两个纯函数从组件中提取到文件顶部独立导出，方便测试
  - 运行命令: `cd web && bun test src/__tests__/providers-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 sonner 已安装
  - `grep "sonner" package.json`
  - 预期: 输出包含 sonner 版本号

- [ ] 验证 ProvidersPage 组件文件存在且正确导出
  - `grep "export function ProvidersPage" web/src/pages/ProvidersPage.tsx`
  - 预期: 输出匹配

- [ ] 验证 ProvidersPage 引用了 Task 1 的 API 函数和 Task 3 的共享组件
  - `grep "apiListProviders\|apiSetProvider\|apiTestProvider\|apiDeleteProvider" web/src/pages/ProvidersPage.tsx | wc -l`
  - 预期: 输出 ≥ 4
  - `grep "DataTable\|FormDialog\|ConfirmDialog\|BatchActionBar\|StatusBadge\|EmptyState" web/src/pages/ProvidersPage.tsx | wc -l`
  - 预期: 输出 ≥ 6

- [ ] 验证测试通过
  - `cd web && bun test src/__tests__/providers-page.test.ts`
  - 预期: 所有测试通过

- [ ] 验证 TypeScript 编译无错误（需 Task 3 组件已创建）
  - `cd web && npx tsc --noEmit --skipLibCheck 2>&1 | grep -i "ProvidersPage" || echo "OK"`
  - 预期: 无 ProvidersPage 相关类型错误

---

### Task 5: Models 管理页面

**背景:**
Models 页面与其他三个模块不同，不是 CRUD 管理，而是"当前配置切换 + 可用模型浏览"的双区域布局。区域一让用户即时切换主模型和轻量模型，区域二展示所有可用模型的只读列表。
后端 POST `/web/config/models` 支持 get（读取当前配置+可用列表）、set（切换模型）、refresh（刷新缓存）三个 action。
本 Task 依赖 Task 1 的 apiGetModels/apiSetModels/apiRefreshModels 函数和 Task 3 的 DataTable/StatusBadge/EmptyState 组件。

**涉及文件:**

- 新建: `web/src/pages/ModelsPage.tsx`

**执行步骤:**

- [ ] 新建 `web/src/pages/ModelsPage.tsx`，实现双区域布局页面
  - 位置: `web/src/pages/ModelsPage.tsx`（新建文件）
  - 导入依赖:

    ```typescript
    import { useState, useEffect, useCallback } from "react";
    import { apiGetModels, apiSetModels, apiRefreshModels } from "../api/client";
    import type { ModelEntry, ModelsConfig } from "../api/client";
    import { DataTable, type Column, StatusBadge, EmptyState } from "@/components/config";
    import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
    import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
    import { Button } from "@/components/ui/button";
    import { Input } from "@/components/ui/input";
    import { RefreshCw } from "lucide-react";
    import { toast } from "sonner";
    ```

- [ ] 实现组件状态和初始化逻辑
  - 位置: `web/src/pages/ModelsPage.tsx` — ModelsPage 函数组件内部
  - 状态定义:

    ```typescript
    export function ModelsPage() {
      const [config, setConfig] = useState<ModelsConfig | null>(null);
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState<string | null>(null); // "model" | "small_model" | null
      const [refreshing, setRefreshing] = useState(false);

      const loadConfig = useCallback(async () => {
        try {
          const data = await apiGetModels();
          setConfig(data);
        } catch (e) {
          toast.error("加载模型配置失败", { description: e instanceof Error ? e.message : "" });
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { loadConfig(); }, [loadConfig]);

      // ... 区域一、区域二渲染
    }
    ```

  - 原因: ModelsConfig 包含 current（当前主/轻量模型）和 available（可用模型列表），单次 API 调用即可获取全部数据

- [ ] 实现 handleModelChange 回调（即时保存）
  - 位置: `web/src/pages/ModelsPage.tsx` — loadConfig 之后
  - 逻辑:

    ```typescript
    const handleModelChange = useCallback(async (field: "model" | "small_model", value: string) => {
      if (!config) return;
      setSaving(field);
      try {
        const result = await apiSetModels({ [field]: value });
        setConfig((prev) => prev ? { ...prev, current: { model: result.model, small_model: result.small_model } } : prev);
        toast.success(`${field === "model" ? "主模型" : "轻量模型"}已切换`);
      } catch (e) {
        toast.error("切换模型失败", { description: e instanceof Error ? e.message : "" });
      } finally {
        setSaving(null);
      }
    }, [config]);
    ```

  - 原因: 设计文档要求"切换后即时保存"，无需提交按钮

- [ ] 实现 handleRefresh 回调
  - 位置: `web/src/pages/ModelsPage.tsx` — handleModelChange 之后
  - 逻辑:

    ```typescript
    const handleRefresh = useCallback(async () => {
      setRefreshing(true);
      try {
        await apiRefreshModels();
        await loadConfig();
        toast.success("可用模型列表已刷新");
      } catch (e) {
        toast.error("刷新失败", { description: e instanceof Error ? e.message : "" });
      } finally {
        setRefreshing(false);
      }
    }, [loadConfig]);
    ```

- [ ] 实现区域一 — 当前模型配置卡片（顶部 Card）
  - 位置: `web/src/pages/ModelsPage.tsx` — return JSX 中
  - 渲染逻辑:

    ```tsx
    {/* 区域一：当前模型配置 */}
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-sm">当前模型配置</CardTitle>
        <CardDescription>切换主模型或轻量模型后立即生效</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* 主模型 */}
          <ModelSelectField
            label="主模型"
            value={config?.current.model ?? ""}
            available={config?.available ?? []}
            disabled={saving === "model"}
            onChange={(v) => handleModelChange("model", v)}
          />
          {/* 轻量模型 */}
          <ModelSelectField
            label="轻量模型"
            value={config?.current.small_model ?? ""}
            available={config?.available ?? []}
            disabled={saving === "small_model"}
            onChange={(v) => handleModelChange("small_model", v)}
          />
        </div>
      </CardContent>
    </Card>
    ```

- [ ] 实现 ModelSelectField 内联子组件
  - 位置: `web/src/pages/ModelsPage.tsx` — ModelsPage 组件之前定义
  - Props 接口和渲染:

    ```typescript
    function ModelSelectField({ label, value, available, disabled, onChange }: {
      label: string;
      value: string;
      available: ModelEntry[];
      disabled: boolean;
      onChange: (value: string) => void;
    }) {
      // 允许手动输入：使用 Input + Select 组合模式
      // 当 value 不在 available 列表中时，显示 Input 允许编辑
      const isCustom = value && !available.some((m) => m.id === value);
      return (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-muted">{label}</label>
          <Select value={value} onValueChange={onChange} disabled={disabled}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择模型..." />
            </SelectTrigger>
            <SelectContent>
              {available.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.label || m.id}</SelectItem>
              ))}
              {isCustom && (
                <SelectItem value={value}>{value}（自定义）</SelectItem>
              )}
            </SelectContent>
          </Select>
          {/* 手动输入区域：允许输入不在列表中的模型 ID */}
          <Input
            placeholder="或手动输入模型 ID"
            value={isCustom ? value : ""}
            onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
            disabled={disabled}
            className="text-xs h-8"
          />
        </div>
      );
    }
    ```

  - 原因: 设计文档要求"选项来自 available 列表 + 允许手动输入"，使用 Select + Input 双模式

- [ ] 实现区域二 — 可用模型列表 DataTable
  - 位置: `web/src/pages/ModelsPage.tsx` — 区域一 JSX 之后
  - 列配置:

    ```typescript
    const columns: Column<ModelEntry>[] = [
      {
        id: "id",
        header: "模型 ID",
        sortable: true,
        cell: (row) => <span className="font-mono text-xs">{row.id}</span>,
      },
      {
        id: "provider",
        header: "服务商",
        sortable: true,
        cell: (row) => row.provider,
      },
      {
        id: "label",
        header: "显示名",
        cell: (row) => row.label || row.id,
      },
      {
        id: "usage",
        header: "使用状态",
        cell: (row) => {
          const statuses: string[] = [];
          if (row.id === config?.current.model) statuses.push("主模型");
          if (row.id === config?.current.small_model) statuses.push("轻量模型");
          if (statuses.length === 0) return <span className="text-text-muted text-xs">—</span>;
          return (
            <div className="flex gap-1">
              {statuses.map((s) => (
                <StatusBadge key={s} variant="success">{s}</StatusBadge>
              ))}
            </div>
          );
        },
      },
    ];
    ```

  - DataTable 渲染:

    ```tsx
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-sm font-semibold text-text-primary">可用模型</h2>
      <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
        <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
        刷新
      </Button>
    </div>
    {config && config.available.length > 0 ? (
      <DataTable<ModelEntry>
        data={config.available}
        columns={columns}
        keyField="id"
        searchPlaceholder="搜索模型..."
      />
    ) : (
      <EmptyState
        title="暂无可用模型"
        description="点击刷新按钮获取最新模型列表"
        action={handleRefresh ? { label: "刷新", onClick: handleRefresh } : undefined}
      />
    )}
    ```

- [ ] 实现 loading 状态渲染
  - 位置: `web/src/pages/ModelsPage.tsx` — return 开头
  - 逻辑:

    ```typescript
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center text-text-muted">
          加载中...
        </div>
      );
    }
    ```

  - 页面整体 JSX 结构:

    ```tsx
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <h1 className="mb-6 text-lg font-semibold text-text-primary">模型管理</h1>
          {/* 区域一 */}
          {/* 区域二 */}
        </div>
      </div>
    );
    ```

- [ ] 为 ModelsPage 辅助函数编写单元测试
  - 测试文件: `web/src/__tests__/models-page.test.ts`
  - 导出待测函数：将 `getModelUsageStatus` 纯函数从 ModelsPage 中提取并导出
  - 新增辅助函数（在 ModelsPage.tsx 中 export）:

    ```typescript
    /** 判断模型 ID 是否为当前主模型或轻量模型 */
    export function getModelUsageStatus(
      modelId: string,
      currentModel: string | null,
      currentSmallModel: string | null
    ): string[] {
      const statuses: string[] = [];
      if (modelId === currentModel) statuses.push("主模型");
      if (modelId === currentSmallModel) statuses.push("轻量模型");
      return statuses;
    }
    ```

  - 测试场景:
    - 主模型返回 ["主模型"]: `getModelUsageStatus("gpt-4", "gpt-4", "gpt-3.5")` → `["主模型"]`
    - 轻量模型返回 ["轻量模型"]: `getModelUsageStatus("gpt-3.5", "gpt-4", "gpt-3.5")` → `["轻量模型"]`
    - 既是主模型又是轻量模型: `getModelUsageStatus("gpt-4", "gpt-4", "gpt-4")` → `["主模型", "轻量模型"]`
    - 未使用的模型返回 []: `getModelUsageStatus("other", "gpt-4", "gpt-3.5")` → `[]`
    - currentModel 为 null 时返回 []: `getModelUsageStatus("gpt-4", null, null)` → `[]`
  - 运行命令: `cd web && bun test src/__tests__/models-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 ModelsPage 组件文件存在且正确导出
  - `grep "export function ModelsPage" web/src/pages/ModelsPage.tsx`
  - 预期: 输出匹配

- [ ] 验证 ModelsPage 引用了 Task 1 的 API 函数和 Task 3 的共享组件
  - `grep "apiGetModels\|apiSetModels\|apiRefreshModels" web/src/pages/ModelsPage.tsx | wc -l`
  - 预期: 输出 ≥ 3
  - `grep "DataTable\|StatusBadge\|EmptyState" web/src/pages/ModelsPage.tsx | wc -l`
  - 预期: 输出 ≥ 3

- [ ] 验证页面不包含不需要的功能
  - `grep -c "FormDialog\|BatchActionBar\|ConfirmDialog" web/src/pages/ModelsPage.tsx`
  - 预期: 输出 0（Models 页面不需要新建/编辑弹窗和批量操作）

- [ ] 验证测试通过
  - `cd web && bun test src/__tests__/models-page.test.ts`
  - 预期: 所有测试通过

- [ ] 验证 TypeScript 编译无错误
  - `cd web && npx tsc --noEmit --skipLibCheck 2>&1 | grep -i "ModelsPage" || echo "OK"`
  - 预期: 无 ModelsPage 相关类型错误

---

### Task 6: Agents 管理页面

**背景:**
Agent 配置是 OpenCode 的核心功能之一，用户需要管理内置 Agent 和自定义 Agent 的模型、模式、工具等参数。后端 `POST /web/config/agents` 已实现 list/get/set/create/delete/set_default 六个 action。内置 Agent（build, plan, general, explore, title, summary, compaction）不允许删除，需在 UI 层隐藏删除按钮实现双重保护。
本 Task 依赖 Task 1 的 API 函数（apiListAgents 等）和 Task 3 的共享组件（DataTable、FormDialog、ConfirmDialog、BatchActionBar、StatusBadge、EmptyState）。

**涉及文件:**

- 新建: `web/src/pages/AgentsPage.tsx`

**执行步骤:**

- [ ] 在 `web/src/pages/AgentsPage.tsx` 中创建 AgentsPage 组件，实现页面整体布局
  - 位置: 新文件 `web/src/pages/AgentsPage.tsx`
  - 导入 Task 1 的 API 函数: `apiListAgents`, `apiGetAgent`, `apiCreateAgent`, `apiSetAgent`, `apiDeleteAgent`, `apiSetDefaultAgent` 及类型 `AgentInfo`, `AgentDetail`, `AgentsListResult`
  - 导入 Task 3 的共享组件: `DataTable`, `FormDialog`, `ConfirmDialog`, `BatchActionBar`, `StatusBadge`, `EmptyState`
  - 导入 shadcn/ui 组件: `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`（模型选择和模式选择）
  - 导入 `Input`, `Label`, `Textarea`, `Button`, `Checkbox`（表单字段）
  - 导入 `toast` from `sonner`（操作反馈）
  - 导入 lucide-react 图标: `Plus`, `Star`, `Trash2`, `Edit`, `Shield`
  - 导入 `apiGetModels` from `../api/client`（获取可用模型列表供模型选择下拉）
  - 页面状态: `agents: AgentInfo[]`, `defaultAgent: string | null`, `loading`, `formOpen`, `editingAgent: AgentDetail | null`, `selectedIds: Set<string>`, `deleteConfirm: { open, names: string[] }`, `availableModels: string[]`, `formData`（表单字段状态）
  - 页面布局: `div.h-full.overflow-y-auto` > `div.mx-auto.max-w-6xl.px-6.py-6` > 标题行（"Agent" + 新建按钮）+ DataTable

- [ ] 定义内置 Agent 名称集合常量
  - 位置: `web/src/pages/AgentsPage.tsx`（文件顶部，组件外部）
  - 与后端 `src/routes/web/config/agents.ts` 中的 `BUILT_IN_AGENTS` 保持一致:

    ```typescript
    const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction"]);
    ```

- [ ] 定义 DataTable 列配置
  - 位置: `AgentsPage` 组件内，`columns` useMemo
  - 列定义:

    ```typescript
    const columns = useMemo<Column<AgentInfo & { isDefault?: boolean }>[]>(() => [
      { id: "name", header: "名称", sortable: true, filterable: true,
        cell: (row) => <span className="font-medium">{row.name}</span> },
      { id: "builtIn", header: "类型", filterable: true,
        cell: (row) => <StatusBadge variant={row.builtIn ? "default" : "secondary"}>
          {row.builtIn ? "内置" : "自定义"}</StatusBadge> },
      { id: "model", header: "模型", sortable: true,
        cell: (row) => row.model || <span className="text-text-muted">-</span> },
      { id: "mode", header: "模式", filterable: true,
        cell: (row) => row.mode ? <StatusBadge variant="outline">{row.mode}</StatusBadge>
          : <span className="text-text-muted">-</span> },
      { id: "steps", header: "步数", sortable: true,
        cell: (row) => row.steps ?? <span className="text-text-muted">-</span> },
      { id: "isDefault", header: "默认", filterable: true,
        cell: (row) => row.isDefault ? <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" /> : null },
      { id: "actions", header: "操作",
        cell: (row) => (
          <div className="flex items-center gap-1">
            {!row.isDefault && (
              <Button size="sm" variant="ghost" onClick={() => handleSetDefault(row.name)}>
                设为默认
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => handleEdit(row.name)}>
              <Edit className="h-3 w-3" />
            </Button>
            {!row.builtIn && (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleSingleDelete(row.name)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        ) },
    ], [defaultAgent]);
    ```

  - 原因: 内置 Agent 的操作列不渲染删除按钮，实现 UI 层保护

- [ ] 实现数据加载逻辑
  - 位置: `AgentsPage` 组件内 `loadAgents` useCallback + useEffect
  - 逻辑:

    ```typescript
    const loadAgents = useCallback(async () => {
      setLoading(true);
      try {
        const result = await apiListAgents();
        const listWithDefault = result.agents.map(a => ({
          ...a,
          isDefault: a.name === result.default_agent,
          steps: a.steps as number | null,
        }));
        setAgents(listWithDefault);
        setDefaultAgent(result.default_agent);
      } catch (e) {
        toast.error("加载Agent列表失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setLoading(false);
      }
    }, []);
    ```

  - 同时加载可用模型列表: 调用 `apiGetModels()` 获取 `available` 数组，提取 `id` 列表存入 `availableModels` 状态

- [ ] 实现新建/编辑弹窗表单
  - 位置: `AgentsPage` 组件内
  - 表单状态 `formData`:

    ```typescript
    interface AgentFormData {
      name: string;
      model: string;
      mode: string;
      steps: number;
      tools: string[];
      prompt: string;
    }
    ```

  - 新建时: `formData` 初始值为 `{ name: "", model: "", mode: "primary", steps: 50, tools: [], prompt: "" }`
  - 编辑时: 调用 `apiGetAgent(name)` 获取完整数据填充表单，`name` 字段设为只读
  - FormDialog 的 `onSubmit` 处理:
    - 新建: 调用 `apiCreateAgent(formData.name, { model, mode, steps, tools, prompt })` → 成功后 `toast.success` + 刷新列表
    - 编辑: 调用 `apiSetAgent(formData.name, { model, mode, steps, tools, prompt })` → 成功后 `toast.success` + 刷新列表
  - 表单字段渲染:
    - 名称: `<Input>` — 新建时可编辑，编辑时 `disabled`，校验 `validateAgentName`
    - 模型: `<Select>` — 选项来自 `availableModels`，同时支持手动输入（当 `availableModels` 中无匹配项时显示输入值）
    - 模式: `<Select>` — 选项为 `primary / subagent / all`
    - 步数: `<Input type="number" min={1} max={200} />`
    - 工具: `<Checkbox>` 多选组 — 固定工具列表 `["bash", "read", "write", "edit", "glob", "grep", "web_search", "web_fetch"]`
    - Prompt: `<Textarea rows={6} />`

- [ ] 实现批量删除逻辑
  - 位置: `AgentsPage` 组件内
  - BatchActionBar: 显示 `{selectedCount} 个已选` + "批量删除"按钮
  - 批量删除处理:

    ```typescript
    const handleBatchDelete = async () => {
      const customNames = Array.from(selectedIds).filter(n => !BUILT_IN_AGENTS.has(n));
      for (const name of customNames) {
        await apiDeleteAgent(name);
      }
      toast.success(`已删除 ${customNames.length} 个Agent`);
      setSelectedIds(new Set());
      setDeleteConfirm({ open: false, names: [] });
      await loadAgents();
    };
    ```

  - 批量删除前弹出 ConfirmDialog，提示"确定要删除选中的 N 个自定义Agent吗？"
  - 原因: 批量删除需过滤掉内置 Agent，仅删除自定义 Agent

- [ ] 实现设为默认逻辑
  - 位置: `AgentsPage` 组件内
  - 逻辑: 调用 `apiSetDefaultAgent(name)` → 成功后 `toast.success("已将 xxx 设为默认Agent")` + 刷新列表

- [ ] 导出纯函数 `validateAgentName` 供单元测试
  - 位置: `web/src/pages/AgentsPage.tsx`（文件顶部，组件外部 export）
  - 逻辑:

    ```typescript
    export function validateAgentName(name: string): string | null {
      if (!name || name.length === 0) return "名称不能为空";
      if (name.length > 64) return "名称不能超过 64 个字符";
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) return "名称只能包含小写字母、数字和单连字符";
      if (name.includes("--")) return "名称不能包含连续连字符";
      return null;
    }
    ```

  - 与后端 `src/routes/web/config/agents.ts` 中 `isValidAgentName` 校验规则一致

- [ ] 为 Agents 页面辅助函数编写单元测试
  - 测试文件: `web/src/__tests__/agents-page.test.ts`
  - 测试场景:
    - `validateAgentName("my-agent")` → 返回 `null`（合法名称）
    - `validateAgentName("MyAgent")` → 返回非 null（包含大写字母）
    - `validateAgentName("a--b")` → 返回非 null（连续连字符）
    - `validateAgentName("")` → 返回 "名称不能为空"
    - `validateAgentName("x".repeat(65))` → 返回非 null（超长）
    - `validateAgentName("123-start")` → 返回 `null`（数字开头合法）
    - `BUILT_IN_AGENTS` 集合包含 7 个内置名称: 验证 `build, plan, general, explore, title, summary, compaction` 全部存在
  - 运行命令: `cd web && bun test src/__tests__/agents-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 AgentsPage 文件已创建且包含所有 API 调用
  - `grep -c "apiListAgents\|apiGetAgent\|apiCreateAgent\|apiSetAgent\|apiDeleteAgent\|apiSetDefaultAgent" web/src/pages/AgentsPage.tsx`
  - 预期: 输出 ≥ 6

- [ ] 验证内置 Agent 保护逻辑存在
  - `grep -c "BUILT_IN_AGENTS" web/src/pages/AgentsPage.tsx`
  - 预期: 输出 ≥ 2（常量定义 + 删除按钮条件渲染）

- [ ] 验证共享组件被正确引用
  - `grep -c "DataTable\|FormDialog\|ConfirmDialog\|BatchActionBar\|StatusBadge" web/src/pages/AgentsPage.tsx`
  - 预期: 输出 ≥ 5

- [ ] 验证测试通过
  - `cd web && bun test src/__tests__/agents-page.test.ts`
  - 预期: 所有测试通过

- [ ] 验证 TypeScript 编译无错误
  - `cd web && npx tsc --noEmit --skipLibCheck 2>&1 | grep -i "AgentsPage" || echo "OK"`
  - 预期: 无 AgentsPage 相关类型错误

---

### Task 7: Skills 管理页面

**背景:**
Skills 是 OpenCode 的可扩展技能系统，用户可编写 Markdown 格式的自定义 Prompt 技能。本 Task 实现技能的完整管理页面，包含列表展示、Markdown 编辑器、启用/禁用切换和批量操作。
Skills 页面是 4 个配置页面中最复杂的一个，独有的 Markdown 编辑器（左右分栏实时预览）和启用/禁用即时切换交互需要特别处理。
依赖 Task 1（apiListSkills 等 6 个 API 函数 + SkillInfo 类型）、Task 3（DataTable、FormDialog、ConfirmDialog、BatchActionBar、StatusBadge、EmptyState）、Task 4（sonner toast 已安装）。

**涉及文件:**

- 新建: `web/src/pages/SkillsPage.tsx`

**执行步骤:**

- [ ] 安装 react-markdown 依赖（Markdown 实时预览渲染）
  - 位置: 项目根目录
  - 命令: `cd web && bun add react-markdown`
  - 原因: 设计文档明确要求使用 react-markdown 进行轻量 Markdown 渲染，不引入 CodeMirror/Monaco 等重量级库

- [ ] 创建 `web/src/pages/SkillsPage.tsx`，实现完整的 Skills 管理页面
  - 位置: `web/src/pages/SkillsPage.tsx`（新建文件）
  - 导入依赖:

    ```
    import { useState, useEffect, useCallback, useMemo } from "react";
    import { toast } from "sonner";
    import {
      apiListSkills, apiGetSkill, apiSetSkill,
      apiDeleteSkill, apiEnableSkill, apiDisableSkill,
      type SkillInfo,
    } from "../api/client";
    import {
      DataTable, type Column, ConfirmDialog, FormDialog,
      BatchActionBar, StatusBadge, EmptyState,
    } from "../../components/config";
    import ReactMarkdown from "react-markdown";
    ```

  - 原因: 与 Task 4 ProvidersPage 保持一致的导入模式

- [ ] 实现 SkillsPage 组件主体 — 状态管理和数据加载
  - 位置: `web/src/pages/SkillsPage.tsx`
  - 状态变量:

    ```typescript
    const [skills, setSkills] = useState<SkillInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    // 弹窗状态
    const [formOpen, setFormOpen] = useState(false);
    const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);

    // 表单字段
    const [formName, setFormName] = useState("");
    const [formDescription, setFormDescription] = useState("");
    const [formLicense, setFormLicense] = useState("");
    const [formCompatibility, setFormCompatibility] = useState("");
    const [formContent, setFormContent] = useState("");
    const [formError, setFormError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // 批量操作确认弹窗
    const [batchAction, setBatchAction] = useState<"enable" | "disable" | "delete" | null>(null);
    ```

  - 加载函数:

    ```typescript
    const loadSkills = useCallback(async () => {
      try {
        const data = await apiListSkills();
        setSkills(data);
      } catch (err) {
        toast.error("加载技能列表失败", { description: err instanceof Error ? err.message : "" });
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { loadSkills(); }, [loadSkills]);
    ```

  - 原因: 与 Task 4/6 的页面数据加载模式一致

- [ ] 实现 DataTable 列配置
  - 位置: `web/src/pages/SkillsPage.tsx`（loadSkills 之后）
  - 列定义:

    ```typescript
    const columns: Column<SkillInfo>[] = useMemo(() => [
      {
        id: "name",
        header: "名称",
        sortable: true,
        filterable: true,
        cell: (skill) => <span className="font-medium">{skill.name}</span>,
      },
      {
        id: "description",
        header: "描述",
        cell: (skill) => (
          <span className="text-text-muted text-sm truncate max-w-[200px] block">
            {skill.description || "—"}
          </span>
        ),
      },
      {
        id: "enabled",
        header: "状态",
        filterable: true,
        cell: (skill) => (
          <StatusBadge variant={skill.enabled ? "success" : "default"}>
            {skill.enabled ? "已启用" : "已禁用"}
          </StatusBadge>
        ),
      },
      {
        id: "actions",
        header: "操作",
        cell: (skill) => (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleToggleEnabled(skill)}
              className="text-xs text-brand hover:underline"
            >
              {skill.enabled ? "禁用" : "启用"}
            </button>
            <button onClick={() => handleEdit(skill)} className="text-xs text-text-muted hover:text-text-primary">
              编辑
            </button>
            <button
              onClick={() => handleDeleteSingle(skill)}
              className="text-xs text-status-error hover:underline"
            >
              删除
            </button>
          </div>
        ),
      },
    ], [skills]);
    ```

  - 原因: 启用/禁用为即时切换按钮（可逆操作不需确认），删除走 ConfirmDialog

- [ ] 实现启用/禁用即时切换处理函数
  - 位置: `web/src/pages/SkillsPage.tsx`（columns 定义之后）
  - 逻辑:

    ```typescript
    const handleToggleEnabled = useCallback(async (skill: SkillInfo) => {
      try {
        if (skill.enabled) {
          await apiDisableSkill(skill.name);
          toast.success(`已禁用 ${skill.name}`);
        } else {
          await apiEnableSkill(skill.name);
          toast.success(`已启用 ${skill.name}`);
        }
        await loadSkills();
      } catch (err) {
        toast.error("操作失败", { description: err instanceof Error ? err.message : "" });
      }
    }, [loadSkills]);
    ```

  - 原因: 设计文档明确"启用/禁用为即时切换，不需要确认（可逆操作）"

- [ ] 实现新建/编辑弹窗（含 Markdown 编辑器）
  - 位置: `web/src/pages/SkillsPage.tsx`
  - 打开新建弹窗:

    ```typescript
    const handleCreate = useCallback(() => {
      setEditingSkill(null);
      setFormName("");
      setFormDescription("");
      setFormLicense("");
      setFormCompatibility("");
      setFormContent("");
      setFormError("");
      setFormOpen(true);
    }, []);
    ```

  - 打开编辑弹窗:

    ```typescript
    const handleEdit = useCallback(async (skill: SkillInfo) => {
      try {
        const detail = await apiGetSkill(skill.name);
        setEditingSkill(detail);
        setFormName(detail.name);
        setFormDescription(detail.description || "");
        setFormLicense(detail.metadata?.license || "");
        setFormCompatibility(detail.metadata?.compatibility || "");
        setFormContent(detail.content || "");
        setFormError("");
        setFormOpen(true);
      } catch (err) {
        toast.error("加载技能详情失败", { description: err instanceof Error ? err.message : "" });
      }
    }, []);
    ```

  - 表单提交:

    ```typescript
    const handleSubmit = useCallback(async () => {
      // 校验
      if (!formName.trim()) { setFormError("名称为必填项"); return; }
      if (!formContent.trim()) { setFormError("内容为必填项"); return; }
      setSubmitting(true);
      try {
        await apiSetSkill(formName.trim(), {
          description: formDescription.trim(),
          content: formContent,
          metadata: {
            ...(formLicense ? { license: formLicense } : {}),
            ...(formCompatibility ? { compatibility: formCompatibility } : {}),
          },
        });
        toast.success(editingSkill ? "技能已更新" : "技能已创建");
        setFormOpen(false);
        await loadSkills();
      } catch (err) {
        toast.error("保存失败", { description: err instanceof Error ? err.message : "" });
      } finally {
        setSubmitting(false);
      }
    }, [formName, formDescription, formContent, formLicense, formCompatibility, editingSkill, loadSkills]);
    ```

  - 弹窗 JSX（嵌入 FormDialog 内部）:

    ```tsx
    <FormDialog
      title={editingSkill ? "编辑技能" : "新建技能"}
      open={formOpen}
      onOpenChange={setFormOpen}
      onSubmit={handleSubmit}
      loading={submitting}
    >
      {/* 名称 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">名称</label>
        <input
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          disabled={!!editingSkill}
          placeholder="skill-name"
          className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm disabled:opacity-50"
        />
      </div>
      {/* 描述 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">描述</label>
        <input
          value={formDescription}
          onChange={(e) => setFormDescription(e.target.value)}
          placeholder="可选"
          className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm"
        />
      </div>
      {/* 许可证 + 兼容性 — 水平排列 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">许可证</label>
          <input value={formLicense} onChange={(e) => setFormLicense(e.target.value)} placeholder="可选"
            className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">兼容性</label>
          <input value={formCompatibility} onChange={(e) => setFormCompatibility(e.target.value)} placeholder="可选"
            className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm" />
        </div>
      </div>
      {/* Markdown 编辑器 — 左右分栏 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">内容 <span className="text-status-error">*</span></label>
        <div className="grid grid-cols-2 gap-2 rounded-md border border-border overflow-hidden" style={{ minHeight: 300 }}>
          {/* 左侧编辑区 */}
          <textarea
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            placeholder="输入 Markdown 内容..."
            className="w-full h-[300px] resize-none bg-surface-0 p-3 text-sm font-mono focus:outline-none"
          />
          {/* 右侧预览区 */}
          <div className="h-[300px] overflow-y-auto bg-surface-1 p-3 text-sm border-l border-border">
            {formContent ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown>{formContent}</ReactMarkdown>
              </div>
            ) : (
              <span className="text-text-muted italic">预览区域</span>
            )}
          </div>
        </div>
      </div>
      {formError && <p className="text-sm text-status-error">{formError}</p>}
    </FormDialog>
    ```

  - 原因: 设计文档要求"左侧 Textarea + 右侧 react-markdown 实时预览"，编辑时名称只读，表单提交使用 apiSetSkill

- [ ] 实现单个删除和批量操作
  - 位置: `web/src/pages/SkillsPage.tsx`
  - 单个删除:

    ```typescript
    const [deleteTarget, setDeleteTarget] = useState<SkillInfo | null>(null);
    const [deleting, setDeleting] = useState(false);

    const handleDeleteSingle = useCallback((skill: SkillInfo) => {
      setDeleteTarget(skill);
    }, []);

    const handleConfirmDelete = useCallback(async () => {
      if (!deleteTarget) return;
      setDeleting(true);
      try {
        await apiDeleteSkill(deleteTarget.name);
        toast.success(`已删除 ${deleteTarget.name}`);
        setDeleteTarget(null);
        await loadSkills();
      } catch (err) {
        toast.error("删除失败", { description: err instanceof Error ? err.message : "" });
      } finally {
        setDeleting(false);
      }
    }, [deleteTarget, loadSkills]);
    ```

  - 批量操作:

    ```typescript
    const [batchDeleting, setBatchDeleting] = useState(false);

    const handleBatchAction = useCallback(async () => {
      if (!batchAction || selectedIds.size === 0) return;
      setBatchDeleting(true);
      try {
        const names = Array.from(selectedIds);
        const promises = names.map((name) => {
          switch (batchAction) {
            case "enable": return apiEnableSkill(name);
            case "disable": return apiDisableSkill(name);
            case "delete": return apiDeleteSkill(name);
          }
        });
        await Promise.all(promises);
        toast.success(`批量操作完成：${batchAction === "enable" ? "启用" : batchAction === "disable" ? "禁用" : "删除"} ${names.length} 个技能`);
        setSelectedIds(new Set());
        setBatchAction(null);
        await loadSkills();
      } catch (err) {
        toast.error("批量操作部分失败", { description: err instanceof Error ? err.message : "" });
      } finally {
        setBatchDeleting(false);
      }
    }, [batchAction, selectedIds, loadSkills]);
    ```

  - 原因: 批量操作需 ConfirmDialog 确认（设计文档要求"删除操作需 ConfirmDialog 提示'此操作不可逆'"），批量启用/禁用也走确认弹窗确保用户知情

- [ ] 实现 JSX 渲染 — 页面布局
  - 位置: `web/src/pages/SkillsPage.tsx`（return 语句）
  - 结构:

    ```tsx
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* 页头 */}
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-text-primary">技能管理</h1>
          <button onClick={handleCreate} className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90">
            新建技能
          </button>
        </div>

        {/* DataTable */}
        {!loading && skills.length === 0 ? (
          <EmptyState title="暂无技能" description="点击'新建技能'创建第一个自定义技能" action={{ label: "新建技能", onClick: handleCreate }} />
        ) : (
          <DataTable<SkillInfo>
            data={skills}
            columns={columns}
            keyField="name"
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            loading={loading}
          />
        )}

        {/* 批量操作浮动工具条 */}
        {selectedIds.size > 0 && (
          <BatchActionBar
            selectedCount={selectedIds.size}
            actions={[
              { label: "批量启用", onClick: () => setBatchAction("enable"), variant: "default" as const },
              { label: "批量禁用", onClick: () => setBatchAction("disable"), variant: "outline" as const },
              { label: "批量删除", onClick: () => setBatchAction("delete"), variant: "destructive" },
            ]}
          />
        )}

        {/* 删除确认弹窗 */}
        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
          title="确认删除"
          description={`此操作不可逆。确定要删除技能"${deleteTarget?.name}"吗？`}
          onConfirm={handleConfirmDelete}
          loading={deleting}
        />

        {/* 批量操作确认弹窗 */}
        <ConfirmDialog
          open={!!batchAction}
          onOpenChange={(open) => { if (!open) setBatchAction(null); }}
          title={`确认批量${batchAction === "enable" ? "启用" : batchAction === "disable" ? "禁用" : "删除"}`}
          description={`确定要对 ${selectedIds.size} 个技能执行批量${batchAction === "enable" ? "启用" : batchAction === "disable" ? "禁用" : "删除"}操作吗？${batchAction === "delete" ? "此操作不可逆。" : ""}`}
          onConfirm={handleBatchAction}
          loading={batchDeleting}
        />

        {/* 新建/编辑弹窗 */}
        {/* （FormDialog 内容已在上方定义） */}
      </div>
    </div>
    ```

  - 原因: 空状态使用 EmptyState 组件，列表用 DataTable，批量操作用 BatchActionBar 浮动工具条

- [ ] 导出 SkillsPage 组件（支持 lazy 加载）
  - 位置: `web/src/pages/SkillsPage.tsx` 文件末尾
  - `export function SkillsPage() { ... }`（命名导出，与 Task 2 的 lazy 加载模式 `lazy(() => import("./pages/SkillsPage").then(m => ({ default: m.SkillsPage })))` 一致）

- [ ] 为 Skills 页面辅助逻辑编写单元测试
  - 测试文件: `web/src/__tests__/skills-page.test.ts`
  - 导出纯函数供测试:

    ```typescript
    // 从 SkillsPage.tsx 中导出
    export function validateSkillForm(data: { name: string; content: string }): string | null {
      if (!data.name.trim()) return "名称为必填项";
      if (!data.content.trim()) return "内容为必填项";
      return null;
    }

    export function buildSkillMetadata(license?: string, compatibility?: string): Record<string, string> {
      const metadata: Record<string, string> = {};
      if (license) metadata.license = license;
      if (compatibility) metadata.compatibility = compatibility;
      return metadata;
    }
    ```

  - 测试场景:
    - `validateSkillForm` 名称和内容都填写时返回 null: `validateSkillForm({ name: "test", content: "# Hello" })` → `null`
    - `validateSkillForm` 名称为空时返回错误: `validateSkillForm({ name: "", content: "# Hello" })` → `"名称为必填项"`
    - `validateSkillForm` 内容为空时返回错误: `validateSkillForm({ name: "test", content: "" })` → `"内容为必填项"`
    - `buildSkillMetadata` 无参数返回空对象: `buildSkillMetadata()` → `{}`
    - `buildSkillMetadata` 有参数返回对应字段: `buildSkillMetadata("MIT", "1.0")` → `{ license: "MIT", compatibility: "1.0" }`
  - 运行命令: `cd web && bun test src/__tests__/skills-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 react-markdown 已安装
  - `grep -q "react-markdown" web/package.json && echo "OK"`
  - 预期: 输出 "OK"

- [ ] 验证 SkillsPage 文件已创建且包含所有 API 调用
  - `grep -c "apiListSkills\|apiGetSkill\|apiSetSkill\|apiDeleteSkill\|apiEnableSkill\|apiDisableSkill" web/src/pages/SkillsPage.tsx`
  - 预期: 输出 ≥ 6

- [ ] 验证 Markdown 编辑器组件（ReactMarkdown 引用）
  - `grep -c "ReactMarkdown" web/src/pages/SkillsPage.tsx`
  - 预期: 输出 ≥ 1

- [ ] 验证批量操作包含启用/禁用/删除三种
  - `grep -c "batchAction.*enable\|batchAction.*disable\|batchAction.*delete" web/src/pages/SkillsPage.tsx`
  - 预期: 输出 ≥ 3

- [ ] 验证删除确认弹窗包含"此操作不可逆"文案
  - `grep "此操作不可逆" web/src/pages/SkillsPage.tsx`
  - 预期: 匹配到至少一行

- [ ] 验证测试通过
  - `cd web && bun test src/__tests__/skills-page.test.ts`
  - 预期: 所有测试通过

- [ ] 验证 TypeScript 编译无错误
  - `cd web && npx tsc --noEmit --skipLibCheck 2>&1 | grep -i "SkillsPage" || echo "OK"`
  - 预期: 无 SkillsPage 相关类型错误

---

### Task 8: Settings UI 验收

**前置条件:**

- 启动命令: `cd web && npx vite dev --port 5173`（开发服务器）
- 后端服务: `bun run src/index.ts`（确保配置 API 可用）
- 登录一个有效的用户账号

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `cd web && bun test 2>&1 | tail -20`
   - 预期: 全部测试通过，0 failures
   - 失败排查: 检查各 Task 的测试步骤，优先确认 API mock 和类型定义正确

2. 验证 Sidebar 显示 7 个入口 + 分隔线
   - 启动开发服务器，打开浏览器登录后，检查 Sidebar
   - 预期: Dashboard + Session + API Keys 为一组，下方有分隔线，服务商/模型/Agent/技能为另一组，再下方分隔线后是退出
   - 失败排查: 检查 Task 2 Sidebar.tsx 的 navItems 配置

3. 验证 4 个配置页面懒加载正常
   - 依次点击 Sidebar 的"服务商"、"模型"、"Agent"、"技能"入口
   - 预期: 每个页面正确加载，URL 分别为 /code/providers、/code/models、/code/agents、/code/skills
   - 失败排查: 检查 Task 2 App.tsx 路由配置和 lazy import 路径

4. 验证 Providers 页面完整 CRUD
   - 新建一个 Provider → 填写名称和 API Key → 保存成功 → 列表刷新显示
   - 编辑该 Provider → 修改 Base URL → 保存成功
   - 点击"测试连接" → 按钮 loading → 成功弹窗显示模型列表 / 失败 Toast 提示
   - 删除该 Provider → ConfirmDialog 确认 → 列表刷新
   - 预期: 所有操作正常，Toast 反馈正确
   - 失败排查: 检查 Task 1 API 函数和 Task 4 页面逻辑

5. 验证 Models 页面模型切换
   - 切换主模型 Select → 即时保存 → 页面刷新后保持
   - 点击"刷新"按钮 → 可用模型列表更新
   - 预期: Select 切换即时生效，刷新正常
   - 失败排查: 检查 Task 5 ModelsPage 的 handleModelChange 和 handleRefresh

6. 验证 Agents 页面新建 Agent 和内置保护
   - 新建自定义 Agent（填写名称、模型、模式、步数） → 保存成功
   - 确认内置 Agent（build/plan/general 等）操作列无"删除"按钮
   - 设为默认 → 星标切换
   - 批量选择自定义 Agent → 批量删除 → ConfirmDialog 确认
   - 预期: 新建成功，内置保护生效，批量操作正常
   - 失败排查: 检查 Task 6 AgentsPage 的 BUILT_IN_AGENTS 过滤逻辑

7. 验证 Skills 页面 Markdown 编辑器
   - 新建 Skill → 填写名称、描述 → 在 Markdown 编辑器左侧输入内容 → 右侧实时预览
   - 保存成功 → 列表显示 → 启用/禁用即时切换
   - 编辑已禁用的 Skill → 保存后自动启用
   - 批量选择 → 批量删除 → ConfirmDialog 显示"此操作不可逆"
   - 预期: Markdown 预览正常，启用/禁用切换即时，自动启用逻辑正确
   - 失败排查: 检查 Task 7 SkillsPage 的 handleSave 和 handleToggle 逻辑

8. 验证 Vite 构建无错误
   - `cd web && npx vite build 2>&1 | tail -10`
   - 预期: 构建成功，无 TypeScript 编译错误
   - 失败排查: 逐一检查各 Task 新增文件的类型导入

9. 验证所有模块搜索/筛选/排序/分页功能
   - 在 Providers 页面搜索框输入文字 → 列表实时过滤
   - 点击"名称"列头排序 → 升序/降序切换
   - 切换每页条数 → 分页正常
   - 预期: DataTable 交互一致且正确
   - 失败排查: 检查 Task 3 DataTable 组件的 filterData/sortData/paginateData 函数
