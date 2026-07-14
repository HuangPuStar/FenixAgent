# 前端技术栈

> React 19 + Vite + TanStack Router + Radix UI + Tailwind CSS v4 + Vercel AI SDK + react-i18next + react-hook-form + sonner

---

## 1. [React 19](https://react.dev) + [Vite](https://vitejs.dev)

**React 19**：唯一前端框架，纯 CSR 模式（无 SSR）。React 19 新特性仅在充分验证兼容性后引入。

**Vite**：构建工具和开发服务器。

- **插件**：`@tanstack/router-plugin/vite`（文件路由代码生成，**必须在 plugins 数组第一位**）、React 插件、Tailwind CSS 插件
- **路径别名**：从前端代码到组件、服务端共享类型、SDK 包的快捷引用
- **构建优化**：精细 vendor chunk 拆分，将核心框架、UI 库、路由库、表单库、代码高亮、图表等按类别独立分块，控制包体积
- **开发代理**：`/web`、`/api` → 后端服务，`/acp` → 后端 WebSocket

**构建产物**：前端构建产物由后端以固定路径前缀托管，修改前端代码后必须重新构建才能生效。

---

## 2. [TanStack Router](https://tanstack.com/router)

**文件路由系统**：文件系统自动生成路由树（生成文件严禁手动编辑）。

- **约定**：特殊前缀文件不贡献 URL 段（layout 组件），另一前缀为动态参数
- **导航**：通过 Router 提供的 Link 组件或导航函数，禁止直接操作 `window.location` 系列 API
- **路由参数**：通过 Router hooks 获取动态参数和 query 参数

**Agent 面板路由结构**：统一布局 `AgentSidebar`（左）+ `ChatPanel`（中）+ `ArtifactsPanel`（右），所有 `/agent/*` 页面共享此布局。

---

## 3. UI 系统

| 库 | 角色 | 约束 |
|----|------|------|
| [Radix UI](https://www.radix-ui.com) | 无障碍交互原语（Dialog、Dropdown、Select 等） | 通过 [shadcn/ui](https://ui.shadcn.com) 包装使用，禁止手写 Radix 原生组件 |
| [Tailwind CSS v4](https://tailwindcss.com) | 原子化样式系统 | 系统字体栈，禁止 CDN 外链字体 |
| [lucide-react](https://lucide.dev) | 通用 UI 图标 | 唯一来源，禁止内联 SVG |
| [@lobehub/icons](https://lobehub.com) | AI 模型/品牌图标（200+ LLM 品牌） | 本地打包，通过 `<ModelIcon>` 统一使用，禁止业务代码直接 import |
| [sonner](https://sonner.emilkowal.ski) | Toast 通知 | 统一反馈入口 |
| [react-hook-form](https://react-hook-form.com) + [zod](https://zod.dev) | 表单状态管理 + 校验 | `FormDialog` 已封装通用模式 |

### 通用业务组件

在 shadcn/ui 原语之上封装了一套通用业务组件（`web/components/config/`），统一项目内高频交互模式：

| 组件 | 用途 |
|------|------|
| **`FormDialog`** | 泛用表单对话框，封装 react-hook-form + zodResolver + shadcn Dialog，支持 i18n 按钮标签 |
| **`DataTable`** | 基于 `@tanstack/react-table` 的通用表格，集成搜索/排序/分页/多选/展开行 |
| **`ConfirmDialog`** | 确认操作对话框，支持 destructive 变体 |
| **`BatchActionBar`** | 批量操作悬浮栏 |
| **`EmptyState`** | 空状态占位卡片 |
| **`ModelConfigDialog`** | 模型配置专用对话框 |
| **`StatusBadge`** | 状态徽标，用于标识启用/禁用等二元状态 |
| **`ModelIcon`** | 模型图标组件，优先查本地对照表，兜底到 `@lobehub/icons`，禁止业务代码直接 import 图标 |
| **`ModelSelectorPopover`** / **`ModelSelectorPicker`** | 模型选择器组件 |

---

## 4. 前端认证与组织上下文

与后端 better-auth 三路认证体系对接：

- **better-auth 客户端**（`web/src/lib/auth-client.ts`）：`createAuthClient` + `organizationClient` + `apiKeyClient`，导出 `useSession`/`signIn`/`signUp`/`signOut`
- **组织上下文传递**：活跃组织 ID 存 localStorage，通过 HTTP header 注入到 `/web/*` 和 `/api/*` 请求；WebSocket relay 通过 query param 传递（因 WS 不支持自定义 header）
- **API Client 自动认证**：`web/src/api/request.ts` 自动携带 Cookie（`credentials: "include"`）

---

## 5. i18n 国际化

**react-i18next + [i18next](https://www.i18next.com)**：英文默认，中英双语。所有前端 TSX 文件无例外走 i18n。

- **命名空间**：使用 `NS` 常量组织翻译资源，禁止字符串字面量
- **翻译文件**：按语言（`en/zh`）和命名空间组织 JSON 文件
- **检测**：localStorage → navigator 兜底 → 英文 fallback
- **新增命名空间**：创建语言文件 → 在 `web/src/i18n/index.ts` 注册 → 组件中引用常量

当前已有 21 个命名空间：`common`、`login`、`sidebar`、`dashboard`、`agents`、`models`、`skills`、`mcp`、`tasks`、`workflows`、`settings`、`sessions`、`environments`、`orgs`、`apikey`、`channels`、`knowledge`、`agentPanel`、`components`、`hindsight`、`agentHome`。

---

## 6. API Client：web/src/api/request.ts

前端 API 调用统一通过 `web/src/api/request.ts`，每个资源域独立 API 模块（`api/tasks.ts`、`api/skills.ts` 等），自动携带认证 Cookie（`credentials: "include"`）。禁止在组件中直接使用原生 `fetch()`。

---

## 7. AI 前端集成：[Vercel AI SDK](https://sdk.vercel.ai)

通过 AI SDK 的 React 集成处理前端消息流。`useChat` hook 管理消息状态（消息类型、流式响应）、发送、接收。

### SSE 实时通信适配

Vercel AI SDK 的 `useChat` 通过定制 `ChatTransport`（`web/src/lib/rcs-transport.ts`）接入后端 SSE 事件流，而非默认的 HTTP stream。`rcs-chat-adapter.ts` 负责将后端会话事件转换为 AI SDK 的 thread entries。

### ACP 协议客户端

前端通过 ACP relay（`web/src/acp/relay-client.ts`）连接后端 WebSocket 中继：

- **`buildRelayUrl()`**：自动拼装协议、主机、组织 ID、session ID 参数
- **`createRelayClient()`**：创建 WebSocket 连接，订阅 agent 事件
- **事件订阅**：`web/src/acp/client.ts` 封装 `acp-link/client`，提供 ACPClient 和所有事件 handler 类型
- **Relay 断连**：前端断连只关 WebSocket，不终止后端 agent 子进程

---

## 8. 前端项目目录结构

```
web/
  components/
    ui/              — shadcn/ui 包装的 Radix UI 原语组件（36 个）
    config/          — 通用业务组件（FormDialog、DataTable、ConfirmDialog 等）
    chat/            — 聊天面板组件
    model-icon/      — 模型图标（ModelIcon + 本地对照表）
    model-selector/  — 模型选择器
  src/
    routes/          — TanStack Router 文件路由（`routeTree.gen.ts` 严禁手动编辑）
    pages/           — 页面组件（agent-panel / workflow / hindsight / login）
    hooks/           — 自定义 hooks（useAuth、useSSE、useACPConnection、useBackoffRetry 等 12 个）
    lib/             — 工具函数（form-utils、retry、token-stats、app-brand、theme、password-crypto 等）
    api/             — API 客户端 + SDK 实例化（sdk.ts）
    acp/             — ACP 协议客户端（client.ts、relay-client.ts、types.ts）
    i18n/            — i18n 配置 + locales/{en,zh}/ 翻译文件
    types/           — 全局类型定义
    __tests__/       — 前端测试（50+ 测试文件）
```

---

## 9. 前端测试方案

- **运行环境**：bun test + happy-dom + React Testing Library
- **测试文件命名**：`<功能>-flow.test.ts`，位于 `web/src/__tests__/`
- **Mock 策略**：fetch mock 或 MSW，禁止在测试文件中使用 `mock.module()`
- **测试原则**：只测关键流程（表单提交、数据操作、导航路由、状态联动），不写类型检查测试和纯 UI 结构断言

---

## 10. 构建与启动

- **启动流程**：`bootstrap.ts` → `loadAppBrand()` 加载品牌配置 → `main.tsx` → `createRouter()` + `RouterProvider`
- **build**：`bun run build:web`，产物写入 `web/dist/`，后端通过 `@elysiajs/static` 以 `base: "/ctrl/"` 前缀托管
- **Vite 代理**：dev 模式下 `/web`、`/api`、`/acp` 代理到后端
- **vendor chunk 拆分**：8 个独立 chunk（shiki / mermaid / motion / vendor / ai-sdk / radix-ui / tanstack / hookform），控制包体积
- **关键约束**：TanStack Router Vite 插件必须在 `plugins` 数组第一位；修改前端代码后必须 `build:web` 才能生效
