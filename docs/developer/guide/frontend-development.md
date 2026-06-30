# 前端开发规范

本文档面向 FenixAgent 前端开发，约束目录组织、组件分层、路由与导航、状态管理、API 调用、国际化、样式和代码组织方式。未特别说明时，以本文件、`CLAUDE.md` 与 `CONTRIBUTING.md` 为准。

## 1. 目录结构

```
web/
├── src/
│   ├── routes/             # TanStack Router 文件路由（routeTree.gen.ts 严禁手动编辑）
│   ├── pages/              # 页面组件（agent-panel / workflow / hindsight / login）
│   ├── hooks/              # 自定义 hooks（useAuth、useSSE、useACPConnection 等 12 个）
│   ├── api/                # API Client + SDK 实例化
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

统一用 `useCallback` + `useEffect` + `try/catch/finally`：

```tsx
const [data, setData] = useState<Item[]>([]);
const [loading, setLoading] = useState(true);

const loadData = useCallback(async () => {
  setLoading(true);
  try {
    const result = await api.list();
    setData(Array.isArray(result.data) ? result.data : []);
  } catch (error) {
    console.error("加载失败", error);
    toast.error(t("loadError", { error: (error as Error).message }));
  } finally {
    setLoading(false);
  }
}, [t]);

useEffect(() => { loadData(); }, [loadData]);
```

Loading 骨架屏守卫在最外层：

```tsx
if (loading) return <SkeletonStructure />;
```

### 3.3 Hooks 约定

- **`useRef` 防重连**：事件订阅 hook（`useSSE`、`useACPConnection`）用 `useRef` 存最新回调，生成稳定引用的 `useCallback([], [])`，避免 `useEffect` 因回调变化反复订阅/取消
- **AbortController**：`useBackoffRetry` 在每次重试前 abort 上一次未完成请求，防止竞态
- **`formXxx` 命名**：手动表单状态变量统一用 `form` 前缀（`formName`、`formSaving`）

## 4. 组件规范

### 4.1 通用业务组件

`web/components/config/` 下封装了项目统一的交互模式：

| 组件 | 用途 | 关键 props |
|------|------|------------|
| `FormDialog` | 通用表单对话框 | `open` / `onOpenChange` / `onSubmit` / `loading` / `formConfig?` |
| `ConfirmDialog` | 删除确认对话框 | `variant: "destructive"` / `onConfirm` / `loading` |
| `AgentCardList` | 卡片列表（内置搜索、空状态、网格） | `items` / `renderCard` / `searchFn` / `emptyMessage` / `gridCols` |
| `EmptyState` | 空状态占位 | `icon` / `title` / `description` / `action` |
| `StatusBadge` | 状态徽标 | `status: "enabled" | "disabled" | "builtIn" | "custom"` |
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

```tsx
const handleSave = async () => {
  if (!formName.trim()) { toast.error(t("validation.nameRequired")); return; }
  setFormSaving(true);
  try {
    await api.save(data);
    toast.success(t("toast.saved"));
    setDialogOpen(false);
    loadData();
  } catch (error) {
    console.error(t("toast.saveFailed"), error);
    toast.error(t("toast.saveFailed", { error: (error as Error).message }));
  } finally {
    setFormSaving(false);
  }
};
```

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
import { taskApi } from "@/src/api/sdk";

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

## 5. API 调用

### 5.1 `@fenix/sdk`

SDK 实例在 `web/src/api/sdk.ts` 中作为无状态单例导出：

```ts
export const envApi = new EnvironmentApi();
export const taskApi = new TaskApi();
export const mcpApi = new McpApi();
// ... 共 20 个实例
```

页面直接 import 使用，`credentials: "include"` 自动携带 Cookie：

```tsx
import { envApi, taskApi, mcpApi } from "@/src/api/sdk";

const { data, error } = await taskApi.list();
if (error) { toast.error(error.message); return; }
```

### 5.2 非 SDK API

不在 `@fenix/sdk` 中的 API 通过原生 `fetch` + 对象字面量手动封装：

```ts
// web/src/api/sdk.ts
export const agentSitesApi = {
  list: () => fetch("/web/agent-sites/apps", { credentials: "include" }).then(r => r.json()),
  create: (body) => fetch("/web/agent-sites/apps", { method: "POST", body: JSON.stringify(body) }),
};

// web/src/api/hindsight.ts
export const hindsightApi = {
  getStatus: () => apiFetch("/web/hindsight/status"),
};
```

### 5.3 错误处理

```tsx
// API 返回 { data, error } 模式
const { data: result, error } = await mcpApi.list();
if (error) {
  console.error("加载失败", error);
  toast.error(t("loadError", { message: error.message }));
}

// try/catch 模式
try {
  await api.save(data);
  toast.success(t("toast.saved"));
} catch (error) {
  console.error(t("toast.saveFailed"), error);
  toast.error(t("toast.saveFailed", { error: (error as Error).message }));
}
```

**强制规则**：`console.error` 必须与 `toast.error` 配对。静默失败仅用于后台刷新等非关键路径。

## 6. i18n 国际化

`react-i18next` + `i18next`，英文默认，中英双语。所有 TSX 文件无例外走 i18n。

### 6.1 使用

```tsx
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

const { t } = useTranslation(NS.TASKS);
t("form.name.label")   // 点号分层
t("title")             // 扁平 key
t("toast.saved", { name: item.name })  // 插值
```

### 6.2 新增命名空间

1. 创建 `web/src/i18n/locales/{en,zh}/<namespace>.json`
2. 在 `web/src/i18n/index.ts` 中 import 并注册 `NS` 常量
3. 组件中用 `useTranslation(NS.XXX)` 引用

### 6.3 规则

- 禁止在 JSX 中硬编码用户可见字符串
- 命名空间用 `NS` 常量，不写字符串字面量
- 中文注释和 `console.log` 不受 i18n 限制

## 7. 样式

### 7.1 Tailwind CSS

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

### 7.2 图标

- **通用 UI 图标**：只用 `lucide-react`，禁止内联 SVG
- **AI 模型图标**：用 `<ModelIcon modelId="gpt-4o" size={16} />`，禁止直接 import `@lobehub/icons`

### 7.3 字体

系统字体栈，禁止外部字体链接。

## 8. 开发落地清单

提交前自检：

- [ ] 用户可见字符串全部走 `t()` i18n
- [ ] 导航使用 `useNavigate()` / `<Link>`，未使用 `window.location` 写操作
- [ ] 新增页面在 `web/src/routes/agent/_panel/` 下，已懒加载
- [ ] `console.error` 与 `toast.error` 配对
- [ ] Loading 态有骨架屏守卫
- [ ] Empty 态有占位提示
- [ ] 表单状态用 `formXxx` 命名
- [ ] Dialog `onOpenChange` 中清理状态
- [ ] 修改后执行 `bun run build:web`
