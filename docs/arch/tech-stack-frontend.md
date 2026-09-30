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

在 shadcn/ui 原语之上封装了一套通用业务组件（`@fenix/ui-components/web/config/`，经 `@fenix/ui-components/config/<name>` 引用），统一项目内高频交互模式：

| 组件 | 用途 |
|------|------|
| **`FormDialog`** | 泛用表单对话框，封装 react-hook-form + zodResolver + shadcn Dialog，支持 i18n 按钮标签 |
| **`DataTable`** | 基于 `@tanstack/react-table` 的通用表格，集成搜索/排序/分页/多选/展开行 |
| **`ConfirmDialog`** | 确认操作对话框，支持 destructive 变体 |
| **`BatchActionBar`** | 批量操作悬浮栏 |
| **`EmptyState`** | 空状态占位卡片 |
| **`ModelConfigDialog`** | 模型配置专用对话框（归 `packages/resources/model-management/web/components/config/ModelConfigDialog.tsx`，不在 `ui-components`） |
| **`StatusBadge`** | 状态徽标，用于标识启用/禁用等二元状态 |
| **`ModelIcon`** | 模型图标组件，优先查本地对照表，兜底到 `@lobehub/icons`，禁止业务代码直接 import 图标 |

---

## 4. 前端认证与组织上下文

与后端 better-auth 三路认证体系对接：

- **better-auth 客户端**（`packages/platform/identity/web/lib/auth-client.ts`）：`createAuthClient` + `organizationClient` + `apiKeyClient`，导出 `useSession`/`signIn`/`signUp`/`signOut`
- **组织上下文传递**：活跃组织 ID 存 localStorage，通过 HTTP header 注入到 `/web/*` 和 `/api/*` 请求；WebSocket relay 通过 query param 传递（因 WS 不支持自定义 header）
- **API Client 自动认证**：`packages/web-runtime/web/api/request.ts` 自动携带 Cookie（`credentials: "include"`）

---

## 5. i18n 国际化

**react-i18next + [i18next](https://www.i18next.com)**：英文默认，中英双语。所有前端 TSX 文件无例外走 i18n。

- **命名空间**：使用 `NS` 常量组织翻译资源，禁止字符串字面量
- **翻译文件**：按语言（`en/zh`）和命名空间组织 JSON 文件
- **检测**：localStorage → navigator 兜底 → 英文 fallback
- **新增命名空间**：创建语言文件 → 在 `apps/web/src/i18n/index.ts` 注册 → 组件中引用常量

当前已登记 **26 个**命名空间（`apps/web/src/i18n/index.ts` 的 `hostResources` + `packageResources` 两张表，`ns` 列表由已登记字典推导）。宿主自有 4 个：`common`、`sidebar`、`components`、`agentPanel`（读 `./locales/**`）；包自有 22 个：`agents`、`agentChat`、`dashboard`、`agentHome`、`apikey`、`login`、`orgs`、`models`、`observer`、`skills`、`mcp`、`tasksV2`、`workflows`、`channels`、`knowledge`、`machine`、`hindsight`、`prodViews`、`pluginMarket`、`sandbox`、`settings`、`uiComponents`。

**与中心表的差集（偏差）**：中心表 `@fenix/web-runtime/i18n/namespace` 现有 26 个字面量，与上面的登记集两个方向都不重合——`tasks`、`sessions`、`environments`、`toolNarrator` 四个零消费空壳**有意不登记**；`agentChat`、`sandbox`、`machine`、`pluginMarket` 四个**已登记但未进中心表**，命名空间常量由各包自持字面量（前两者按「中心表只收录跨包共用项」的口径刻意不入表，后两者记为中心表待补）。

---

## 6. API Client：packages/web-runtime/web/api/request.ts

前端 API 调用统一通过 `packages/web-runtime/web/api/request.ts`，每个资源域在自己的 owner 包内独立成 API 模块（如 `@fenix/resource-task` 的 `web/api/tasks-v2.ts`、`@fenix/resource-skill` 的 `web/api/skills.ts`），自动携带认证 Cookie（`credentials: "include"`）。禁止在组件中直接使用原生 `fetch()`。

---

## 7. AI 前端集成：[Vercel AI SDK](https://sdk.vercel.ai)

通过 AI SDK 的 React 集成处理前端消息流。`useChat` hook 管理消息状态（消息类型、流式响应）、发送、接收。

### SSE 实时通信适配

Vercel AI SDK 的 `useChat` 通过定制 `ChatTransport` 接入后端 SSE 事件流，而非默认的 HTTP stream。`rcs-chat-adapter.ts` 负责将后端会话事件转换为 AI SDK 的 thread entries。

### ACP/YJS 通信通道

前端通过单条 `/acp/yjs/:agentId` WebSocket 连接后端，使用 YJS CRDT 进行增量数据同步：

- **`buildYjsUrl()`** / **`createYjsWs()`**：`packages/agent-runtime/web/yjs/yjs-ws.ts` 中封装，自动拼装协议、主机、agentId 参数
- **ChatPanel**：前端 WS 唯一入口，在挂载时创建连接

---

## 8. 前端项目目录结构

```
apps/web/
  src/
    routes/          — TanStack Router 文件路由（`routeTree.gen.ts` 严禁手动编辑）
    pages/           — 宿主专有页面（agent-panel 及其 artifacts 子目录）
    shell/           — 应用壳与侧栏装配（布局、导航容器、Provider、鉴权后壳）
    components/      — 宿主壳组件（错误页、路由兜底）
    api/             — 宿主专有域客户端（只剩 branding.ts）
    hooks/           — 宿主自有 hook（当前为空，见前端规范 §3.5）
    lib/             — 宿主工具函数（app-brand、random-uuid-polyfill、clipboard-polyfill、streamdown-table-patch 等）
    i18n/            — i18n 引导 + 宿主自有字典 locales/{en,zh}/（包自有字典经 `@fenix/<pkg>/web/i18n` 登记）
    types/           — 宿主全局类型声明（global.d.ts）
    __tests__/       — 前端测试
packages/
  ui-components/web/ — 通用 UI 原语（ui/）、通用业务组件（config/）、聊天组件（chat/）、样式（styles/）
  <group>/<pkg>/web/ — 各 owner 包的 web 面（pages/、hooks/、api/、components/、i18n/）
```

---

## 9. 前端测试方案

- **运行环境**：bun test + happy-dom + React Testing Library
- **测试文件命名**：`<功能>-flow.test.ts`，位于 `apps/web/src/__tests__/`
- **Mock 策略**：fetch mock 或 MSW，禁止在测试文件中使用 `mock.module()`
- **测试原则**：只测关键流程（表单提交、数据操作、导航路由、状态联动），不写类型检查测试和纯 UI 结构断言

---

## 10. 构建与启动

- **启动流程**：`apps/web/src/main.tsx` → `loadAppBrand()` 加载品牌配置 → `createRouter()` + `RouterProvider`
- **build**：`bun run build:web`，产物写入 `apps/web/dist/`，后端通过 `@elysiajs/static` 以 `base: "/ctrl/"` 前缀托管
- **Vite 代理**：dev 模式下 `/web`、`/api`、`/acp` 代理到后端
- **vendor chunk 拆分**：8 个独立 chunk（shiki / mermaid / motion / vendor / ai-sdk / radix-ui / tanstack / hookform），控制包体积
- **关键约束**：TanStack Router Vite 插件必须在 `plugins` 数组第一位；修改前端代码后必须 `build:web` 才能生效
