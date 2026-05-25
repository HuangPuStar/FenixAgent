# 前端技术债清单

> 评估日期：2026-05-20
> 评估范围：`web/` 目录下全部前端代码
> 评估方法：基于最近 10 天 git 历史（277 commits）+ 全量代码扫描

---

## 概览

| 统计项 | 数值 |
|--------|------|
| 页面组件 | 15 个（Dashboard、Environments、Session、Models、Agents、Skills、MCP、Tasks、Channels、KnowledgeBases、Workflow、Teams、ApiKeys、Login、Agent Panel） |
| shadcn/ui 原子组件 | 32 个 |
| 业务组件 | ~20 个 |
| 自定义 Hooks | 10 个 |
| 前端测试文件 | 41 个 |
| API 模块文件 | 5 个（client、sse、config-response、workflow-defs、workflow-engine、meta-agent） |
| 类型定义文件 | 4 个（types/config、types/index、types/knowledge、lib/types） |

---

## 技术债分级标准

- **P0 — 事故级**：已造成或即将造成生产事故（白屏、数据丢失等）
- **P1 — 阻塞性**：严重影响开发效率或系统可维护性
- **P2 — 功能性**：功能缺失或体验降级，但不阻塞主线
- **P3 — 优化性**：代码质量或开发体验改进

---

## P0 — 事故级

### TD-001 全局无 ErrorBoundary

**现状**：整个前端无 ErrorBoundary 组件。任何组件渲染阶段的未捕获异常（TypeError、Cannot read property of undefined 等）会导致 React 整棵子树卸载，用户看到白屏。

**影响范围**：全部 15 个页面。

**证据**：
```
grep -r "ErrorBoundary\|error-boundary\|componentDidCatch\|getDerivedStateFromError" web/src/
# 零结果
```

**修复方案**：

1. 在 `web/src/components/ErrorBoundary.tsx` 创建 React class component ErrorBoundary
2. 在 `App.tsx` 的 `<Suspense>` 外层包裹 `<ErrorBoundary>`
3. 对 WorkflowEditor 等高风险组件额外添加局部 ErrorBoundary

**预计工作量**：1-2 小时

---

### TD-002 WorkflowEditor 单文件 2506 行

**现状**：`web/src/pages/workflow/WorkflowEditor.tsx` 包含 2506 行代码，融合了编辑器外壳、工具栏、节点面板、属性面板、运行控制、YAML 解析、事件处理等所有逻辑。

**影响**：
- 几乎无法安全修改（任何改动都可能影响不相关功能）
- 代码审查困难
- 零测试覆盖（无任何单元/集成测试）

**修复方案**：拆分为独立子组件：

```
web/src/pages/workflow/
├── WorkflowEditor.tsx        # 外壳，< 300 行
├── EditorToolbar.tsx         # 工具栏（运行/停止/保存/发布）
├── NodePalette.tsx           # 节点类型选择面板
├── PropertiesPanel.tsx       # 右侧节点属性编辑面板
├── RunStatusPanel.tsx        # 运行状态/输出查看面板
├── MiniMapPanel.tsx          # 小地图
├── useWorkflowEditor.ts      # 编辑器状态管理 hook
├── useWorkflowRunner.ts      # 运行控制 hook
└── nodes.tsx                 # 自定义节点组件（已有）
```

**预计工作量**：1 天（拆分 + 验证功能不退化）

---

## P1 — 阻塞性

### TD-003 纯手写路由，无路由库

**现状**：`App.tsx` 使用 `window.history.pushState` + `popstate` 事件 + 7 个 useState 手动管理所有路由状态。无 react-router / @tanstack-router 等路由库依赖。

**具体问题**：
- 7 个路由相关 state（`currentSessionId`, `currentSessionCwd`, `currentAgentId`, `showApiKeys`, `configView`, `agentPanelMode`, `agentPanelAgentId/agentPanelSessionId`）
- 5 个 navigate 回调（`navigateToSession`, `navigateToDashboard`, `navigateToApiKeys`, `navigateToConfig`, agent panel 解析）
- 每个 navigate 回调都要手动重置所有其他 state，遗漏即 bug
- 无嵌套路由支持（agent-panel 和 workflow 子路由全靠 prop drilling）
- 无路由守卫（认证检查散落在 App.tsx 渲染逻辑）
- URL 与 state 双向绑定靠手动维护，容易不同步
- 浏览器前进/后退行为不可靠

**证据**：`package.json` 中无 `react-router`、`@tanstack/router`、`wouter` 等依赖。

**修复方案**：引入 `react-router` v7，将路由逻辑从 App.tsx 抽离：

```tsx
// 路由定义示例
createBrowserRouter([
  { path: "/", element: <Dashboard /> },
  { path: "/models", element: <ModelsPage /> },
  { path: "/agents", element: <AgentsPage /> },
  { path: "/:sessionId", element: <SessionDetail /> },
  { path: "/agent", element: <AgentAppShell /> },
  { path: "/agent/:agentId", element: <AgentAppShell /> },
  { path: "/agent/:agentId/:sessionId", element: <AgentAppShell /> },
  { path: "/workflow", element: <WorkflowPage /> },
  // ...
])
```

**预计工作量**：1-2 天

---

### TD-004 SSEBus 重复实现

**现状**：两个文件各自实现了一个 SSE 事件总线类，逻辑高度相似：

| 文件 | 类名 | 行数 |
|------|------|------|
| `web/src/lib/rcs-transport.ts` | `SSEEventBus` | ~60 行 |
| `web/src/lib/rcs-chat-adapter.ts` | `SSEBus` | ~56 行 |

两者都实现了：
- `connect(sessionId)` — 创建 EventSource
- `disconnect()` — 关闭 EventSource
- `onEvent(handler)` — 注册事件监听器

差异仅在 seqNum 去重（transport 有，adapter 无）。

**修复方案**：合并为一个共享模块 `web/src/lib/sse-bus.ts`，两个消费者引用同一个实例。

**预计工作量**：2-3 小时

---

### TD-005 fetch 全局拦截器是 hack

**现状**：`web/src/contexts/TeamContext.tsx` 中通过 monkey-patching `window.fetch` 注入 `X-Active-Team-Id` header：

```typescript
const origFetch = window.fetch;
window.fetch = (input, init) => {
  const activeTeamId = localStorage.getItem("active_team_id");
  if (activeTeamId) {
    const headers = new Headers(init?.headers);
    headers.set("X-Active-Team-Id", activeTeamId);
  }
  return origFetch(input, init);
};
```

**问题**：
- Eden Treaty 内部也使用 fetch，拦截器可能在 TeamProvider 初始化前就被 Eden 实例捕获到旧版本
- 第三方库（如 better-auth）的 fetch 调用也会被注入 header，可能造成意外
- 多次 mount TeamProvider 会重复包装 fetch（虽然有 `fetchInterceptorInstalled` guard，但逻辑脆弱）

**修复方案**：
- 方案 A：Eden Treaty 支持自定义 fetch，在创建 client 时注入 header
- 方案 B：创建统一的 `apiFetch` 函数替代裸 `fetch`，页面组件通过 hook 获取
- 方案 C：引入 TanStack Query 的 queryFn 统一处理

**预计工作量**：半天（取决于选哪个方案）

---

### TD-006 类型定义分散且部分过时

**现状**：前端类型定义分散在三处：

| 位置 | 内容 | 问题 |
|------|------|------|
| `web/src/types/config.ts` (321行) | Provider/Model/Agent/Skill/MCP 类型 | 完整 |
| `web/src/types/index.ts` (215行) | Environment/Session/Channel/File 类型 | `agent_name` 字段已过时 |
| `web/src/types/knowledge.ts` (36行) | 知识库类型 | 完整 |
| `web/src/lib/types.ts` (89行) | ThreadEntry 聊天数据模型 | 独立模块 |
| `web/src/api/workflow-engine.ts` | Workflow 引擎类型 | 内嵌在 API 文件中 |

**具体过时问题**：
- `Environment` 类型仍有 `agent_name: string | null`，后端已删除该字段，改用 `agentConfigId`
- 缺少 Task（定时任务）、API Key、Instance（实例）等业务类型定义
- Workflow 类型定义在 API 文件中而非 `types/` 目录
- 无统一的 re-export 策略（`hooks/index.ts` 只 re-export 3 个）

**修复方案**：
1. 在 `types/index.ts` 中补充缺失的业务类型
2. 删除 `agent_name` 等过时字段
3. Workflow 类型从 API 文件迁移到 `types/workflow.ts`
4. 统一 re-export 策略

**预计工作量**：半天

---

## P2 — 功能性

### TD-007 无数据缓存层

**现状**：所有页面使用 `useState` + `useEffect` + `fetch` 手动管理数据获取。同一数据可能被多个页面重复请求，无缓存、无自动重试、无 stale-while-revalidate。

**影响**：
- 环境列表在 Dashboard 和 EnvironmentsPage 各自独立请求
- 模型列表在多个配置页重复拉取
- 切换页面后返回需要重新加载

**修复方案**：引入 TanStack Query（React Query），统一数据获取模式。

**预计工作量**：1-2 天（引入 + 逐步迁移各页面）

---

### TD-008 前端 API 模块未独立封装

**现状**：仅 workflow-defs、workflow-engine、meta-agent 三个模块有独立 API 文件。其余模块（config/providers、config/models、config/agents、config/skills、config/mcp、environments、sessions、channels、knowledge-bases、files、tasks、api-keys）的 API 调用散落在各页面组件中，通过 Eden Treaty `client` 直接调用。

**影响**：
- 页面组件同时承担 UI 渲染和 API 调用逻辑
- 错误处理散落各处，无法统一
- 无法统一做缓存/重试/log

**修复方案**：按模块抽取独立 API 文件到 `web/src/api/` 目录，每个模块包含类型定义 + API 函数 + 错误处理。

**涉及模块**（按优先级）：
1. `config.ts` — 合并 providers/models/agents/skills/mcp 五个子模块
2. `environments.ts` — 环境管理 CRUD
3. `sessions.ts` — 会话列表/历史
4. `tasks.ts` — 定时任务 CRUD
5. `knowledge-bases.ts` — 知识库管理
6. `api-keys.ts` — API Key 管理
7. `channels.ts` — 渠道管理
8. `files.ts` — 文件系统操作

**预计工作量**：2-3 天

---

### TD-009 Agent Panel 主页面为占位符

**现状**：`web/src/pages/agent-panel/AgentPanelPage.tsx` 仅 3 行代码，只有 `<div>Agent Panel (placeholder)</div>`。实际的 Agent Panel 功能通过 `AgentAppShell.tsx` 在 App.tsx 路由中直接挂载。

**影响**：
- `AgentPanelPage.tsx` 是死代码
- Agent Panel 的路由入口和实现不匹配

**修复方案**：删除 `AgentPanelPage.tsx`，或将 AgentAppShell 的路由逻辑迁移到该页面。

**预计工作量**：1 小时

---

### TD-010 无 a11y 体系

**现状**：32 个 UI 组件中只有 1 个包含 `aria-` 属性。无键盘导航、无焦点管理、无颜色对比度系统性验证。

**影响**：不符合 WCAG 2.1 AA 标准，对残障用户不友好。

**修复方案**：作为持续性改进，逐步在核心交互组件（Dialog、Select、Table）中补充 ARIA 属性和键盘事件处理。

**预计工作量**：持续（每次修改相关组件时顺带补充）

---

### TD-011 无国际化框架

**现状**：所有 UI 文字硬编码为中文。有 5 个 i18n 测试文件检查中文字符串存在性，但这不是真正的国际化。未使用 react-i18next 等框架。

**影响**：无法支持多语言切换。

**修复方案**：引入 react-i18next，提取所有硬编码字符串到 JSON 语言文件。优先级较低，等有多语言需求时再实施。

**预计工作量**：3-5 天（全面提取 + 框架搭建）

---

## P3 — 优化性

### TD-012 hooks/index.ts 只 re-export 3 个

**现状**：`web/src/hooks/` 有 10 个 hook 文件，但 `hooks/index.ts` 只 re-export 了 `useCommands`、`useModels`、`useQRScanner` 三个。

**修复**：补全 re-export，统一 import 路径。

**预计工作量**：15 分钟

---

### TD-013 rcs-chat-adapter 中 as any 遗留

**现状**：`web/src/lib/rcs-chat-adapter.ts` 中有多处 `as any` 类型断言：

```typescript
const { data: historyData } = await client.web.sessions({ id: this.sessionId }).history.get();
const events = (historyData as any)?.events;  // 应有明确类型

await client.web.sessions({ id: this.sessionId }).events.post({
  type: "user", ...
} as any);  // 应注册 body schema
```

**修复**：为 Eden Treaty 补充 body/response 类型定义。

**预计工作量**：1-2 小时

---

### TD-014 无 E2E 测试框架

**现状**：41 个前端测试全部是单元测试（Bun test），无 Playwright/Cypress 端到端测试。关键业务流程（登录→创建环境→启动实例→发送消息→查看回复）无自动化验证。

**修复**：引入 Playwright，编写核心流程冒烟测试。

**预计工作量**：2-3 天（框架搭建 + 5-10 个核心场景）

---

### TD-015 配置页共享组件 shadcn 路径约定不一致

**现状**：shadcn/ui 组件放在 `web/components/ui/`（非 `web/src/components/ui/`），需要通过 tsconfig paths `@/components` 才能正确引用。这不符合 shadcn 的默认约定（通常在 `src/components/ui/`），容易让新开发者困惑。

**修复**：保持现状（改路径成本高），但在 README 或 CLAUDE.md 中明确说明路径约定。

**预计工作量**：文档级

---

## 改进路线图

### 第一阶段：止血（1 周内）

| 编号 | 项目 | 工作量 |
|------|------|--------|
| TD-001 | 全局 ErrorBoundary | 1-2h |
| TD-012 | hooks/index.ts 补全 re-export | 15min |

### 第二阶段：还债（2-4 周）

| 编号 | 项目 | 工作量 |
|------|------|--------|
| TD-003 | 引入 react-router | 1-2d |
| TD-004 | 合并 SSEBus | 2-3h |
| TD-005 | 移除 fetch 拦截器 hack | 0.5d |
| TD-006 | 统一类型定义 | 0.5d |
| TD-009 | 清理 Agent Panel 占位符 | 1h |

### 第三阶段：基建升级（1-2 月）

| 编号 | 项目 | 工作量 |
|------|------|--------|
| TD-002 | WorkflowEditor 拆分 | 1d |
| TD-007 | 引入 TanStack Query | 1-2d |
| TD-008 | 抽取独立 API 模块 | 2-3d |
| TD-013 | 消除 as any 遗留 | 1-2h |

### 第四阶段：质量提升（持续）

| 编号 | 项目 | 工作量 |
|------|------|--------|
| TD-014 | 引入 E2E 测试 | 2-3d |
| TD-010 | a11y 逐步补充 | 持续 |
| TD-011 | 国际化框架 | 3-5d |
| TD-015 | 路径约定文档 | 文档级 |

---

## 附录：评估数据来源

| 数据项 | 来源 |
|--------|------|
| 文件列表 | `find web/src -type f -name "*.tsx" -o -name "*.ts"` |
| 代码行数 | `wc -l` 各关键文件 |
| 路由库依赖 | `grep react-router package.json` |
| ErrorBoundary | `grep -r "ErrorBoundary" web/src/` |
| a11y 覆盖 | `grep -r "aria-" web/src/components/ --include="*.tsx" -l | wc -l` |
| shadcn 组件数 | `ls web/components/ui/ | wc -l` → 32 |
| 测试文件数 | `ls web/src/__tests__/ | wc -l` → 41 |
| SSEBus 重复 | `rcs-transport.ts` vs `rcs-chat-adapter.ts` 源码比对 |
| fetch 拦截器 | `TeamContext.tsx` 源码审查 |
| 类型过时 | `types/index.ts` vs `src/db/schema.ts` 字段比对 |
