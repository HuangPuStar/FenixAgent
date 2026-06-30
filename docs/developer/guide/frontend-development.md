# 前端开发规范

> **版本**：v1.0.0 | **最后更新**：2026-06-30 | **维护者**：前端团队
>
> **最近变更**：
> - v1.0.0 (2026-06-30)：初始版本，覆盖路由、状态管理、组件、API、安全、错误边界、WebSocket、i18n、样式、开发落地清单

本文档面向 FenixAgent 前端开发，约束目录组织、路由与导航、状态管理、组件规范、API 调用、安全规范、错误边界、WebSocket 通信、i18n 国际化和样式体系。未特别说明时，以本文件、`CLAUDE.md` 与 `CONTRIBUTING.md` 为准。

## 1. 目录结构

```
web/
├── src/
│   ├── routes/             # TanStack Router 文件路由（routeTree.gen.ts 严禁手动编辑）
│   ├── pages/              # 页面组件（agent-panel / workflow / hindsight / login）
│   ├── hooks/              # 自定义 hooks（useAuth、useSSE、useACPConnection 等 12 个）
│   ├── api/                # API 建模层（按资源域分文件：tasks.ts / skills.ts / sites.ts 等）
│   ├── acp/                # ACP 协议客户端（client.ts、relay-client.ts、types.ts）
│   ├── lib/                # 工具函数（form-utils、retry、token-stats、theme 等）
│   ├── i18n/               # i18n 配置 + locales/{en,zh}/ 翻译文件
│   ├── types/              # 全局类型定义
│   ├── contexts/           # React Context（OrgContext）
│   └── __tests__/          # 前端测试
├── components/
│   ├── ui/                 # shadcn/ui 包装的 Radix UI 原语组件
│   ├── config/             # 通用业务组件（FormDialog、DataTable、ConfirmDialog 等）
│   ├── chat/               # 聊天面板组件
│   ├── model-icon/         # 模型图标（ModelIcon + 本地对照表）
│   └── agent-panel/        # Agent 面板专属组件
```

## 2. 路由与导航

使用 TanStack Router（file-based routing），`web/src/routes/` 下文件自动映射为 URL。

### 2.1 文件命名约定

| 语法 | 含义 | 示例 |
|------|------|------|
| `_panel` | 布局片段（不贡献 URL 段） | `_panel.tsx` → 所有 `/agent/*` 共享布局 |
| `$param` | 动态路径参数 | `chat.$agentId.tsx` → `/agent/chat/:agentId` |
| `_` 后缀 | 分隔相邻动态参数 | `chat.$agentId_.$sessionId.tsx` |

新增页面：在 `web/src/routes/agent/_panel/` 下创建 `.tsx` 文件。

### 2.2 导航

```tsx
import { useNavigate, Link } from "@tanstack/react-router";

// 编程式导航
const navigate = useNavigate();
void navigate({ to: "/agent/home" });
void navigate({ to: "/agent/chat/$agentId", params: { agentId: envId } });
void navigate({ to: "/agent/workflow/$id/edit", params: { id }, search: { runId } });

// 声明式导航
<Link to="/agent/home">Home</Link>
```

**禁止** `window.location.href` / `window.location.replace` / `window.history.pushState`。`window.location` 仅允许读取（`pathname` / `search` / `host` / `protocol`）。

### 2.3 路由参数

```tsx
const { agentId } = Route.useParams();         // 路径参数
const search = useSearch({ strict: false });   // 查询参数
```

### 2.4 懒加载

```tsx
const Page = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentModelsPage").then((m) => ({
    default: m.AgentModelsPage,
  })),
);

export const Route = createFileRoute("/agent/_panel/models")({
  component: () => (
    <Suspense fallback={<LoadingSpinner />}>
      <Page />
    </Suspense>
  ),
});
```

### 2.5 侧边栏

导航项通过 `web/src/pages/agent-panel/AgentSidebarConfig.tsx` 声明式定义——`NavGroup[]` 数组，每项含 `id`（映射到路由 `/agent/:id`）、`labelKey`（i18n key）、`icon`（lucide-react 组件）。

## 3. 状态管理

使用 **React Context + `useState`/`useCallback`**，不引入 Zustand/Jotai 等第三方状态库。

### 3.1 全局 Context

```
<ThemeProvider>       ← 主题管理（system/light/dark）
  <OrgProvider>       ← 组织管理（fetch 拦截器注入 X-Active-Org-Id）
    <RouterProvider>
```

Context 必须使用守卫 hook 消灭 `undefined` 判断：

```tsx
export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used within OrgProvider");
  return ctx;
}
```

### 3.2 数据获取

使用 **ahooks `useRequest`** 统一管理异步状态，禁止手写 `useCallback` + `useEffect` + `setState` 组合来管理数据获取。

```tsx
import { useRequest } from "ahooks";

// 查询：自动管理 loading / error / data 三态
const { data, loading, error, refresh } = useRequest(
  async () => {
    const { success, data, error } = await taskApi.list();
    if (!success) throw new Error(error.message);
    return data;
  }
);

// 变更：manual 模式，手动触发
const { run: createTask, loading: creating } = useRequest(
  async (body: Record<string, unknown>) => {
    const { success, error } = await taskApi.create(body);
    if (!success) throw new Error(error.message);
  },
  {
    manual: true,
    onSuccess: () => {
      refresh();                         // 创建成功后刷新列表
      toast.success(t("toast.saved"));
    },
    onError: (err) => {
      console.error("创建任务失败", err);
      toast.error(err.message);
    },
  }
);
```

**优势**：自动处理 loading/error/data 状态、请求去重、防竞态（`loading` 期间不重复触发）。消除组件中散落的 `useState(loading)`、手动 `try/catch/finally` 和 Effect 依赖管理。

**缓存配置**：

```tsx
const { data, loading, refresh } = useRequest(
  async () => {
    const { success, data, error } = await taskApi.list();
    if (!success) throw new Error(error.message);
    return data;
  },
  {
    cacheKey: "tasks-list",       // 跨组件共享缓存，同 key 的 useRequest 共享同一份数据
    staleTime: 60_000,            // 60s 内视为新鲜，不重新请求
    cacheTime: 300_000,           // 5min 后清除缓存
    retryCount: 2,                // 失败自动重试 2 次
    retryInterval: 2000,          // 重试间隔 2s
    refreshDeps: [orgId],         // 依赖变化时自动重新请求
    ready: !!orgId,               // 条件查询：orgId 存在时才发起请求
    debounceWait: 300,            // 搜索输入防抖 300ms
  }
);
```

**跨组件刷新**：当一处组件修改数据后需要通知其他组件刷新时，使用 `cacheKey` + 全局 `refresh`：

```tsx
// 组件 A：查询 tasks 列表
const { data, refresh } = useRequest(fetchTasks, { cacheKey: "tasks-list" });

// 组件 B：创建 task 后，通过 cacheKey 刷新所有订阅该 key 的组件
const { run: createTask } = useRequest(saveTask, {
  manual: true,
  onSuccess: () => {
    // 方式 1：通过 useRequest 的 mutate 直接更新缓存（乐观更新）
    // cache.mutate("tasks-list", (prev) => [...prev, newItem]);

    // 方式 2：触发所有同 cacheKey 的组件重新请求
    refresh();  // 仅刷新当前组件
    // 需要全局刷新时，从提取到父组件的 refresh 或通过事件总线触发
  },
});
```

**请求取消**：ahooks `useRequest` 自动处理竞态——多次调用 `run()` 时，上一次未完成的请求会被忽略（latest-promise-wins）。如需手动取消，通过 `cancel()` 和 `AbortSignal`：

```tsx
const { run, cancel, loading } = useRequest(
  async (query: string) => {
    const { success, data } = await someApi.search(query);
    // ahooks 已自动丢弃过期响应，无需手动 AbortController
    return data;
  },
  { manual: true, debounceWait: 300 }
);
// cancel() 可主动取消当前进行中的请求
```

**Loading / Empty / Error 状态**：

```tsx
if (loading) return <Skeleton className="h-32 w-full" />;
if (error) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-muted">
      <p>{error.message}</p>
      <Button variant="outline" onClick={refresh}>{t("common.retry")}</Button>
    </div>
  );
}
if (!data?.length) return <EmptyState icon={<FolderOpen />} title={t("empty.title")} />;
```

### 3.3 Hooks 约定

- **`useRef` 防重连**：事件订阅 hook（`useSSE`、`useACPConnection`）用 `useRef` 存最新回调，生成稳定引用的 `useCallback([], [])`，避免 `useEffect` 因回调变化反复订阅/取消
- **AbortController**：`useBackoffRetry` 在每次重试前 abort 上一次未完成请求，防止竞态
- **表单使用 react-hook-form**：`useForm` + `zodResolver`，不手写 `useState` 管理表单状态。命名约定：`form = useForm<FormValues>(...)`、`formSchema = z.object({...})`

## 4. 组件规范

**shadcn/ui 已有组件禁止重复开发**。`web/components/ui/` 下已有的基础组件（Button、Input、Select、Dialog、Tabs、Skeleton 等 36 个），直接使用，不手写替代品。

### 4.1 通用业务组件

`web/components/config/` 下封装了项目统一的交互模式：

| 组件 | 用途 | 关键 props |
|------|------|------------|
| `FormDialog` | 通用表单对话框 | `open` / `onOpenChange` / `title` / `form` / `onSubmit` / `loading` |
| `ConfirmDialog` | 删除确认对话框 | `variant: "destructive"` / `onConfirm` / `loading` |
| `EmptyState` | 空状态占位 | `icon` / `title` / `description` / `action` |
| `StatusBadge` | 状态徽标 | `status` (string，通过 colorMap 映射颜色) |
| `AgentPageHeader` | 统一页面标题栏 | `title` / `subtitle` / `actions` |

### 4.2 Dialog 状态管理

三个关联 `useState` 控制新增/编辑/删除：

```tsx
const [dialogOpen, setDialogOpen] = useState(false);
const [editingItem, setEditingItem] = useState<Item | null>(null);  // null=创建
const [confirmOpen, setConfirmOpen] = useState(false);
const [deleteTarget, setDeleteTarget] = useState<Item | null>(null);
```

**创建**：清空编辑状态 → `setDialogOpen(true)`
**编辑**：填充表单 → `setDialogOpen(true)`
**`onOpenChange`** 回调中清理状态：`if (!open) resetState()`

### 4.3 表单提交

使用 **react-hook-form + zod** 配合 **FormDialog** 封装，禁止手动 `useState` + 手写校验。FormDialog 接受外部 `useForm` 实例，表单逻辑归位到页面组件：

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v4";
import { useRequest } from "ahooks";
import { FormDialog } from "@/components/config/FormDialog";

const formSchema = z.object({
  name: z.string().min(1, "名称不能为空"),
  cronExpression: z.string().min(1, "Cron 表达式不能为空"),
});

type FormValues = z.infer<typeof formSchema>;

const form = useForm<FormValues>({
  resolver: zodResolver(formSchema),
  defaultValues: { name: "", cronExpression: "" },
});

const { run: saveTask, loading: saving } = useRequest(
  async (body: FormValues) => {
    const { success, error } = editingItem
      ? await taskApi.update(editingItem.id, body)
      : await taskApi.create(body);
    if (!success) throw new Error(error.message);
  },
  {
    manual: true,
    onSuccess: () => {
      refresh();               // 返回列表后刷新
      toast.success(t("toast.saved"));
      setDialogOpen(false);
    },
    onError: (error) => {
      console.error("保存失败", error);
      toast.error(error.message);
    },
  }
);

// FormDialog 接受外部 form 实例，内部调用 form.handleSubmit(onSubmit) 统一校验
<FormDialog
  open={dialogOpen}
  onOpenChange={setDialogOpen}
  title={t("dialog.createTask")}
  form={form}
  onSubmit={saveTask}        // saveTask 直接接收 form.handleSubmit 传入的校验后值
  loading={saving}
>
  {/* 表单字段通过 register 绑定到 form */}
  <Input {...form.register("name")} placeholder={t("form.name.placeholder")} />
  <Input {...form.register("cronExpression")} placeholder={t("form.cron.placeholder")} />
</FormDialog>
```

**强制规则**：`console.error` 必须与 `toast.error` 配对，确保错误可追踪。静默失败仅用于后台刷新等非关键路径。

### 4.4 组件声明

统一使用 **`function` 声明**（不写箭头函数组件）：

```tsx
export function AgentSkillsPage() { ... }
export function AgentPageHeader({ title, subtitle }: Props) { ... }
```

### 4.5 类型定义

- **页面内联**：只在该页面使用的类型，`interface` 定义在组件函数上方
- **独立文件**：跨页面共用的类型放 `web/src/types/`

### 4.6 文件结构

```tsx
// 1. React / 框架
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

// 2. 路由
import { Link, useNavigate } from "@tanstack/react-router";

// 3. 第三方 UI 库
import { Bot, Plus, Search, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

// 4. 项目内部模块
import { taskApi } from "@/src/api/tasks";

// 5. i18n
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

// 6. 类型（按需）
import type { TaskInfo } from "@/src/types";

export function AgentTasksPage() {
  const { t } = useTranslation(NS.TASKS);
  // ...
}
```

## 5. API 建模层

前端通过 `web/src/api/` 下的 API 模块统一管理后端接口调用，禁止在组件中直接写 `fetch`。

### 5.1 原则

- 每个后端资源域 → 一个 `web/src/api/<domain>.ts` 文件 → 一个命名的 API 对象导出
- 组件只 import API 模块，不写 URL 字符串、不调 `fetch`
- 共享基础设施集中在 `web/src/api/request.ts` 基础模块，各域模块 import 使用
- API 模块负责：URL 拼装、请求/响应序列化、错误统一处理
- 组件负责：调用 API → 处理结果 → 更新 UI

### 5.2 共享基础模块 `request.ts`

所有域模块共享同一个 `web/src/api/request.ts`，统一管理 credentials、header 注入、错误标准化、超时、日志：

```ts
// web/src/api/request.ts

/** 统一错误码体系 */
export type ErrorCode =
  | "NETWORK_ERROR"    // 网络不通、CORS、超时
  | "SERVER_ERROR"     // 5xx
  | "NOT_FOUND"        // 404
  | "VALIDATION_ERROR" // 参数校验失败
  | "UNAUTHORIZED"     // 401/403
  | "UNKNOWN";         // 兜底

/** 统一 API 响应类型 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: ErrorCode; message: string };
}

/** 统一分页响应结构 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  params?: Record<string, string>;                           // 路径参数 :id 插值
  query?: Record<string, string | number | boolean | undefined>;  // 查询参数自动拼装
  body?: BodyInit | Record<string, unknown>;                 // JSON 对象或 FormData/Blob
  timeout?: number;                                           // 超时 ms，默认 30000
  signal?: AbortSignal;                                      // 外部取消信号
}

const DEFAULT_TIMEOUT = 30_000;

export async function request<T>(url: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const { params, query, body, timeout = DEFAULT_TIMEOUT, signal: externalSignal, ...init } = options;

  // 路径参数插值：/web/tasks/:id → /web/tasks/abc
  let resolvedUrl = url;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      resolvedUrl = resolvedUrl.replace(`:${key}`, encodeURIComponent(value));
    }
  }

  // 查询参数拼装
  if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) sp.set(k, String(v));
    }
    const qs = sp.toString();
    if (qs) resolvedUrl += `?${qs}`;
  }

  // 超时控制 + 外部 AbortSignal 合并
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const combinedSignal = externalSignal
    ? anySignal(controller.signal, externalSignal)
    : controller.signal;

  // 请求体序列化：普通对象 → JSON，FormData/Blob 直传
  let resolvedBody: BodyInit | undefined;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob) {
      resolvedBody = body;
    } else {
      headers["content-type"] = "application/json";
      resolvedBody = JSON.stringify(body);
    }
  }

  try {
    const r = await fetch(resolvedUrl, {
      credentials: "include",
      signal: combinedSignal,
      headers: { ...headers, ...Object.fromEntries(new Headers(init.headers).entries()) },
      ...init,
      body: resolvedBody,
    });
    clearTimeout(timeoutId);

    // 非 JSON 响应（如文件下载）不解析 body
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      if (!r.ok) {
        console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl} ${r.status}`);
        return { success: false, error: { code: statusToCode(r.status), message: `请求失败 (${r.status})` } };
      }
      return { success: true, data: undefined as unknown as T };
    }

    const json = await r.json();
    if (!r.ok || json.success === false) {
      console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl}`, json?.error);
      return { success: false, error: json?.error ?? { code: statusToCode(r.status), message: `请求失败 (${r.status})` } };
    }
    return { success: true, data: (json.data ?? json) as T };
  } catch (err) {
    clearTimeout(timeoutId);
    if ((err as Error).name === "AbortError") {
      return { success: false, error: { code: "NETWORK_ERROR", message: "请求超时或已取消" } };
    }
    console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl}`, err);
    return { success: false, error: { code: "NETWORK_ERROR", message: "网络异常，请检查连接" } };
  }
}

function statusToCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 422) return "VALIDATION_ERROR";
  if (status >= 500) return "SERVER_ERROR";
  return "UNKNOWN";
}

function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const c = new AbortController();
  const onAbort = (reason: unknown) => c.abort(reason);
  if (a.aborted) { c.abort(a.reason); return c.signal; }
  if (b.aborted) { c.abort(b.reason); return c.signal; }
  a.addEventListener("abort", () => onAbort(a.reason), { once: true });
  b.addEventListener("abort", () => onAbort(b.reason), { once: true });
  return c.signal;
}
```

### 5.3 非标准响应适配

部分后端接口不走 `{ success, data, error }` 格式，在域模块内做适配转换：

| 接口类型 | 原始响应 | 域模块适配方式 |
|----------|----------|---------------|
| config 域 action 分发 | `{ ok, content }` / `{ success, error }` 无 data | 域模块内 `return { success: true, data: json }` 统一包装 |
| provider test | `{ ok: true, data }` / `{ ok: false, error }` | 映射 `ok → success` 保持原字段 |
| 文件上传 | FormData → `{ success, data: { url } }` | 使用 `request()` BodyInit 分支直传 |
| WebSocket / SSE | 非 REST 协议 | 不走 `request()`，走第 8 章 ACP |

### 5.4 域模块标准模式

以 tasks 域为例，域模块从 `api/request.ts` import 共享 `request` 函数和类型：

```ts
// web/src/api/tasks.ts
import { request } from "./request";
import type { ApiResponse, PaginatedResponse } from "./request";
import type { TaskInfo } from "../types";

export const taskApi = {
  /** 分页列表 */
  list: (query?: { page?: number; pageSize?: number; keyword?: string }) =>
    request<PaginatedResponse<TaskInfo>>("/web/tasks", { query }),

  /** 获取单个 */
  get: (id: string) => request<TaskInfo>("/web/tasks/:id", { params: { id } }),

  /** 创建 */
  create: (body: { name: string; cronExpression: string }) =>
    request<TaskInfo>("/web/tasks", { method: "POST", body }),

  /** 更新 */
  update: (id: string, body: Partial<{ name: string; cronExpression: string }>) =>
    request<TaskInfo>("/web/tasks/:id", { method: "PUT", params: { id }, body }),

  /** 删除 */
  del: (id: string) => request<void>("/web/tasks/:id", { method: "DELETE", params: { id } }),
};
```

### 5.5 域模块命名与组织

| 规则 | 说明 | 示例 |
|------|------|------|
| 文件名 kebab-case | 与路由路径一致 | `knowledge-bases.ts`、`workflow-defs.ts` |
| 导出对象 camelCase + `Api` 后缀 | 避免与类型名冲突 | `knowledgeBaseApi`、`workflowApi` |
| REST 模块放 `api/` 根 | 标准 CRUD 接口 | `api/tasks.ts`、`api/skills.ts` |
| SSE/WS 传输模块放 `acp/` | 非 REST 协议，独立管理 | `acp/client.ts`、`acp/relay-client.ts` |

### 5.6 SDK 模块 → 域模块迁移映射

从 `@fenix/sdk` 类架构迁移到域模块的对照表：

| 原 SDK 模块 | 迁移后域模块 | 接口数 | 说明 |
|-------------|-------------|--------|------|
| `config/providers` | `api/providers.ts` | 6 | config 域 5 模块合 1 |
| `config/models` | `api/models.ts` | 5 | ↑ |
| `config/agents` | `api/agents.ts` | 5 | ↑ |
| `config/skills` | `api/skills.ts` | 5 | ↑ |
| `config/mcp` | `api/mcp.ts` | 5 | ↑ |
| `sessions` | `api/sessions.ts` | 4 | — |
| `instances` | `api/instances.ts` | 3 | — |
| `knowledgeBases` | `api/knowledge-bases.ts` | 5 | — |
| `tasks` | `api/tasks.ts` | 5 | — |
| `workflows` / `workflowVersions` / `workflowJobs` | `api/workflows.ts` | 10 | 3 模块合 1 |
| `environments` | `api/environments.ts` | 4 | — |
| `registry/machines` | `api/registry.ts` | 3 | — |
| `channels` | `api/channels.ts` | 4 | — |

重构期间新旧共存：新模块用 `ApiResponse<T>`（来自 `request.ts`），旧 SDK 用 `ApiResult<T>`（来自 `@fenix/sdk`），逐步替换后删除 SDK。

### 5.7 组件中使用

API 模块配合 ahooks `useRequest` 使用，不在组件中直接 `await` 调用：

```tsx
import { useRequest } from "ahooks";
import { taskApi } from "@/src/api/tasks";

// 查询：自动管理 loading / error / data，组件挂载时自动执行
const { data, loading, error, refresh } = useRequest(
  async () => {
    const { success, data, error } = await taskApi.list({ page: 1, pageSize: 20 });
    if (!success) throw new Error(error.message);
    return data;
  }
);

// 变更：manual 模式，手动触发，成功后刷新列表
const { run: saveTask, loading: saving } = useRequest(
  async (body: { name: string; cronExpression: string }) => {
    const { success, error } = editingItem
      ? await taskApi.update(editingItem.id, body)
      : await taskApi.create(body);
    if (!success) throw new Error(error.message);
  },
  {
    manual: true,
    onSuccess: () => {
      refresh();
      toast.success(t("toast.saved"));
    },
    onError: (err) => {
      console.error("保存失败", err);
      toast.error(err.message);
    },
  }
);
```

### 5.8 禁止事项

- **禁止**在组件中直接写 `fetch("/web/xxx")`
- **禁止**在 `useEffect` 中裸调 `fetch` 不封装
- **禁止**在组件中拼装后端 URL
- **禁止**在域模块中重复定义 `request()`——统一从 `api/request.ts` import
- **禁止**在 API 模块内调用 `toast.error`（UI 层职责，错误由组件 `onError` 处理）

迁移标的：现有从 `@/src/api/sdk`（`@fenix/sdk`）导入的 29 个文件应按 5.6 映射表逐域迁移到新域模块。

## 6. 安全规范

前端安全是质量基线，以下规则**必须**遵守，违反需在 code review 中 block。

### 6.1 XSS 防护

- **禁止**使用 `dangerouslySetInnerHTML`，除非经过显式的 DOMPurify/sanitize-html 清洗且附 code review 批准注释
- 用户生成内容（UGC）渲染前**必须**经过清洗函数处理
- 禁止直接拼接 HTML 字符串注入 DOM

```tsx
// ❌ 禁止
<div dangerouslySetInnerHTML={{ __html: userInput }} />

// ✅ 允许（需清洗 + 注释说明理由 + review 批准）
import DOMPurify from "dompurify";
// 该内容来自受信管理后台，已通过 DOMPurify 清洗，仅允许安全标签
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(trustedHtml, { ALLOWED_TAGS: ["b", "i", "p"] }) }} />
```

### 6.2 API Key / Token 安全

- **禁止**将 API Key、Token、Secret 存入 `localStorage` 或 `sessionStorage`
- 认证 Token 仅通过 HttpOnly Cookie 传输，前端不直接读写
- 前端配置中出现的密钥占位符（如 `{env:RCS_SECRET_xxx}`）**不得**在前端代码中展开或替换
- API Key 创建成功后仅展示一次，前端**不得**将明文 Key 持久化到任何本地存储

### 6.3 敏感操作

- 删除、权限变更、组织转移等敏感操作**必须**经过二次确认（ConfirmDialog `variant: "destructive"`）
- 敏感操作的 API 调用**禁止**在 URL 中携带敏感参数（使用 POST body）

## 7. 错误边界

使用 React ErrorBoundary 防止单组件崩溃导致整个页面白屏。

### 7.1 放置规则

- **每个路由段**至少包裹一个 ErrorBoundary
- 独立功能面板（如 ChatPanel、ArtifactsPanel、Sidebar）各自包裹独立的 ErrorBoundary，一个面板崩溃不影响其他面板
- 顶层根布局需要一个兜底 ErrorBoundary

```tsx
import { ErrorBoundary } from "react-error-boundary";

function ChatPanelFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex flex-col items-center gap-3 p-6">
      <p className="text-sm text-muted">{error.message}</p>
      <Button variant="outline" onClick={resetErrorBoundary}>{t("common.retry")}</Button>
    </div>
  );
}

<ErrorBoundary FallbackComponent={ChatPanelFallback} onError={(err) => console.error("ChatPanel 崩溃", err)}>
  <ChatPanel />
</ErrorBoundary>
```

**放置矩阵**：

| 层级 | 包裹范围 | ErrorBoundary 位置 | 关键/非关键 |
|------|----------|-------------------|------------|
| 根布局 | 整个应用 | `RootLayout` 最外层 | 关键（兜底） |
| Agent 面板布局 | `_panel.tsx` 路由布局 | 包裹 `{children}` 出口 | 关键（Agent 页整体） |
| ChatPanel | 聊天交互面板 | `ChatPanel` 根组件 | 关键（核心功能） |
| ArtifactsPanel | 输出展示面板 | `ArtifactsPanel` 根组件 | 非关键（可降级） |
| Sidebar | 左侧导航 | `AgentSidebar` 根组件 | 非关键（可降级） |

- **关键** ErrorBoundary：降级 UI 占据原有的布局区域，提供明确的重试按钮
- **非关键** ErrorBoundary：可收缩为最小化状态（如一条错误提示条），不影响主内容区
- 降级 UI 统一使用同一套 `ErrorFallback` 组件，通过 `variant: "full" | "compact"` 区分样式

### 7.2 降级策略

- ErrorBoundary 的 `FallbackComponent` 必须提供**重试按钮**（调用 `resetErrorBoundary`）
- 降级 UI 不应改变页面布局结构，避免级联布局崩溃
- `onError` 回调中必须 `console.error` 记录原始错误，便于排查
- 错误边界捕获的错误不需要额外 `toast.error`（降级 UI 本身就是用户可见反馈）

## 8. WebSocket / 实时通信

项目通过 ACP 协议 WebSocket 进行前端与 Agent 实例的实时通信，相关 hooks 位于 `web/src/acp/` 和 `web/src/hooks/`。

### 8.1 连接生命周期

- **建立**：组件 mount 时通过 `useACPConnection(sessionId)` 建立连接
- **断开**：组件 unmount 时自动断开（hook 内部 `useEffect` 清理）
- **超时**：WebSocket 连接超时 > 30s，心跳包由 relay 层拦截不透传前端

### 8.2 重连策略

使用指数退避 + 随机抖动，最大间隔 30 秒：

```tsx
// useACPConnection 内部实现约束
const backoff = Math.min(1000 * Math.pow(2, retryCount) + Math.random() * 1000, 30000);
```

- 用 `useRef` 存储最新回调，生成稳定引用的 `useCallback([], [])`，避免 `useEffect` 因回调变化反复订阅/取消
- 每次重试前通过 `AbortController` abort 上一次未完成请求，防止竞态

### 8.3 消息类型

ACP relay 通道转发的消息类型：

| 类型 | 方向 | 说明 |
|------|------|------|
| `agent/status` | 后端 → 前端 | Agent 状态变更（依赖 `capabilities` 判断 ACP 能力，relay 层**必须**转发） |
| `agent/output` | 后端 → 前端 | Agent 输出内容 |
| `agent/input` | 前端 → 后端 | 用户输入/控制指令 |
| `keep_alive` | relay 内部 | 心跳维护，relay 层拦截，**不得**透传前端 |

### 8.4 SSE 降级

当 WebSocket 不可用时，使用 SSE（Server-Sent Events）作为降级通道。`useSSE` hook 通过 EventBus 接收事件，支持断线重连。

## 9. i18n 国际化

`react-i18next` + `i18next`，英文默认，中英双语。所有 TSX 文件无例外走 i18n。

### 9.1 使用

```tsx
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

const { t } = useTranslation(NS.TASKS);
t("form.name.label")   // 点号分层
t("title")             // 扁平 key
t("toast.saved", { name: item.name })  // 插值
```

### 9.2 新增命名空间

1. 创建 `web/src/i18n/locales/{en,zh}/<namespace>.json`
2. 在 `web/src/i18n/index.ts` 中 import 并注册 `NS` 常量
3. 组件中用 `useTranslation(NS.XXX)` 引用

### 9.3 规则

- 禁止在 JSX 中硬编码用户可见字符串
- 命名空间用 `NS` 常量，不写字符串字面量
- 中文注释和 `console.log` 不受 i18n 限制

## 10. 样式

### 10.1 Tailwind CSS

项目使用 CSS 变量体系（非 Tailwind 默认色板）：

| 变量 | 用途 |
|------|------|
| `text-bright` / `text-primary` / `text-secondary` / `text-muted` | 文字层级 |
| `bg-surface-0` / `bg-surface-1` / `bg-surface-2` | 背景层级 |
| `border-border` / `border-border-light` | 边框 |
| `bg-brand` / `text-brand` | 品牌色 |

```tsx
// 组织风格：语义分组
<div className="flex items-center justify-between mb-4">
<div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
<div className="space-y-3">
```

`cn()` 仅限 `web/components/ui/` 下的基础组件使用，业务页面直接写 className 字符串。

### 10.2 图标

- **通用 UI 图标**：只用 `lucide-react`，禁止内联 SVG
- **AI 模型图标**：用 `<ModelIcon modelId="gpt-4o" size={16} />`，禁止直接 import `@lobehub/icons`

### 10.3 字体

系统字体栈，禁止外部字体链接。

## 11. 开发落地清单

### 11.1 提交前自检

- [ ] **`bun run precheck` 通过**（biome format → biome check import-sort → tsc → biome check）
- [ ] 用户可见字符串全部走 `t()` i18n
- [ ] 导航使用 `useNavigate()` / `<Link>`，未使用 `window.location` 写操作
- [ ] 新增页面在 `web/src/routes/agent/_panel/` 下，已懒加载
- [ ] API 调用通过 `@/src/api/` 建模层，组件中无裸 `fetch`
- [ ] Loading 态有骨架屏守卫
- [ ] Empty 态有占位提示
- [ ] 表单使用 react-hook-form + zod，不手写 `useState` 校验
- [ ] Dialog `onOpenChange` 中清理状态
- [ ] 无 `dangerouslySetInnerHTML` 不经清洗使用
- [ ] 无 API Key/Token 存入 localStorage
- [ ] 独立面板包裹 ErrorBoundary（ChatPanel / ArtifactsPanel / Sidebar）
- [ ] 修改后执行 `bun run build:web`

### 11.2 自动化检测

目前工具链 (Biome + tsc) 能自动覆盖约 30% 的规则。以下关键规则建议尽快配置 ESLint / pre-commit hook 实现自动化拦截：

| 规则 | 检测方式 | 优先级 |
|------|----------|--------|
| 组件中裸调 `fetch()` | ESLint `no-restricted-imports` / 自定义规则 | P0 |
| `window.location.href` 写操作 | ESLint `no-restricted-globals` 限制 `location=` 和 `location.assign()` | P0 |
| `dangerouslySetInnerHTML` 不经清洗 | ESLint `no-restricted-syntax` 匹配 JSX 属性 | P1 |
| `localStorage.setItem` 存敏感 key | ESLint `no-restricted-syntax` 检测 key 参数 | P1 |
| `console.error` 缺配对 `toast.error` | 自定义 ESLint rule（需语义分析，短期保持人工 review） | P2 |
| import 六组分组顺序 | Biome import-sort（已覆盖） | — |
| 格式化 | Biome format（已覆盖） | — |

**pre-commit hook** 建议配置 lint-staged，在 `git commit` 时自动运行 `bun run precheck` + ESLint。

## 附录 A：重构施工指南

本附录描述从当前代码库（手动 useState + @fenix/sdk + localStorage token）迁移到目标架构的增量路径。

### A.1 施工顺序

```
Phase 1 ─── 基础设施          预计影响面：0 个消费者文件
Phase 2 ─── API 层原型        预计影响面：1 个新域模块
Phase 3 ─── 模板页面          预计影响面：1 个页面
Phase 4 ─── 错误边界铺设      预计影响面：5 个路由/面板
Phase 5 ─── 表单密集型批处理   预计影响面：6 个页面
Phase 6 ─── 展示密集型批处理   预计影响面：4 个页面
Phase 7 ─── 组织页面          预计影响面：1 个页面
Phase 8 ─── 清理收尾          预计影响面：删除 sdk.ts
```

| Phase | 具体工作 | 产出 |
|-------|----------|------|
| **1. 基础设施** | `package.json` 添加 `ahooks` + `react-error-boundary`；创建 `web/src/api/request.ts` 共享模块；FormDialog 添加 `form` prop（兼容旧 `formConfig`） | 依赖就位，request.ts 就位 |
| **2. API 层原型** | 按 5.6 映射表创建第一个域模块 `api/tasks.ts`（最简单的 CRUD 域） | 域模块模板 |
| **3. 模板页面** | 选 `AgentApiKeysPage`（255 行，一个表单字段）端到端迁移，验证 useRequest + request<T> + FormDialog 外部 form 完整链路 | 可复制的迁移模板 |
| **4. 错误边界** | `_panel.tsx` + ChatPanel / ArtifactsPanel / Sidebar 包裹 ErrorBoundary，设计统一 `ErrorFallback` 组件（`variant: "full" | "compact"`） | 错误隔离体系 |
| **5. 表单密集型** | AgentTasksPage、AgentSkillsPage、AgentMcpPage、AgentModelsPage、AgentManagementPage、AgentChannelsPage、AgentKnowledgeBasesPage | 7 页面完成 |
| **6. 展示密集型** | AgentSitesPage、AgentSessionsPage、AgentHomePage、AgentDashboardPage | 4 页面完成 |
| **7. 组织页面** | AgentOrganizationsPage（独立 auth/org 流程） | 完成 |
| **8. 清理收尾** | 删除 `web/src/api/sdk.ts`，移除所有 `@fenix/sdk` import，验证 29 个消费者文件 | sdk.ts 消失 |

### A.2 新旧共存约定

重构期间新旧两套模式并存。区分规则：

| 层面 | 旧模式（现状） | 新模式（目标） | 过渡期共存方式 |
|------|--------------|--------------|--------------|
| API 响应类型 | `ApiResult<T>` (from `@fenix/sdk`) | `ApiResponse<T>` (from `api/request.ts`) | 两类型共存，新域模块用新类型，旧 SDK 引用保持旧类型 |
| API 调用 | `sdk.tasks.list()` 类实例 | `taskApi.list()` 命名导出 | 新域模块与旧 SDK 并行，消费者逐文件切换 import |
| 数据获取 | `useState(loading)` + `useEffect` + `fetch` | `useRequest(service)` | 同一组件内不混用，按 Phase 逐页面替换 |
| 表单 | `useState(formName)` + 手写校验 | `useForm` + `zodResolver` + `FormDialog form` prop | FormDialog 兼容新旧两种模式 |
| 错误隔离 | 无 | `ErrorBoundary` 包裹 | 新加包裹不影响旧逻辑，逐步铺设 |

### A.3 进度度量

建议用 Issue Label 追踪迁移进度：

- `migration/api-layer` — API 域模块迁移
- `migration/data-fetching` — useState+useEffect → useRequest
- `migration/forms` — 手动表单 → react-hook-form+zod
- `migration/error-boundary` — ErrorBoundary 铺设

每个 Issue 关联对应的域模块或页面，完成即 close。Phase 8 收尾时上述 4 个 label 下应无 open issue。
