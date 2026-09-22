# 前端开发规范

> **版本**：v2.0.0 | **最后更新**：2026-09-22 | **维护者**：前端团队
>
> **最近变更**：
> - v2.0.0 (2026-09-22)：按 §1.6 T11e 收口后的架构校订。§1 重写为"目录结构与包边界"（宿主不再持有 UI 组件、API 建模层、Context 的副本），新增 §1.2 包边界与引用纪律、§1.3 路径别名纪律；§3.1 组织上下文改为 `OrgSession` 契约投影；§5 按 owner 包 `web/api/` 现状整节重写，§5.2 由内嵌实现改为契约摘要；新增 §4.7 文件规模、§8.4 前端 Chat 约束；删除附录 A（迁移已完成）
> - v1.0.0 (2026-06-30)：初始版本，覆盖路由、状态管理、组件、API、安全、错误边界、WebSocket、i18n、样式、开发落地清单

本文档面向 FenixAgent 前端开发，约束目录组织、包边界、路由与导航、状态管理、组件规范、API 调用、安全规范、错误边界、WebSocket 通信、i18n 国际化和样式体系。未特别说明时，以本文件、`CLAUDE.md` 与 `CONTRIBUTING.md` 为准。

## 状态标记约定

本文档区分三种规则状态，**不把"已决定"写成"已实现"**（判据见 `docs/need-to-change/35-make-architecture-docs-versioned-truth.md`）：

| 标记 | 含义 | 违反后果 |
|------|------|----------|
| **current** | 现行不变量，代码已按此实现 | 计入 code review 违规 |
| **target** | 已定目标态，尚未落地 | 新代码不得反向加固现状；差距按在途项推进 |
| **transitional** | 明确在途整改中，过渡期双写/双语义 | 按对应 need-to-change 编号跟踪，不得把过渡形态当规范扩散 |

标注为 target / transitional 的规则均在正文给出对应的 `docs/need-to-change/` 编号。前端相关在途项：**25** 请求单一失败语义、**26** 组织上下文原子切换、**27** 异步工作绑定 identity/generation、**28** 共享交互 Primitive 可访问性、**29** 前端性能预算、**41** i18n 作为 ViewModel 契约。

## 1. 目录结构与包边界

### 1.1 宿主目录

```
apps/web/src/
├── routes/          # TanStack Router 文件路由（routeTree.gen.ts 严禁手动编辑）
├── pages/           # 宿主页面（LoginPage、agent-panel 容器）
├── shell/           # 本版本最终 Shell：布局、导航容器、Provider、鉴权后壳
├── api/             # 宿主专有域 API 模块（无资源包归属的接口，见 1.2）
├── lib/             # 宿主工具函数（theme、retry、form-utils、polyfill 等）
├── i18n/            # i18n 装配：聚合各包 web/i18n 的 NS 与资源
├── hooks/           # 宿主 hooks（use-task-views 等）
├── components/      # 宿主业务组件（FilePickerDialog、agent-panel/*）
├── types/           # 宿主视图类型
└── __tests__/       # 前端测试
```

以下能力**不在宿主**，一律由包提供，宿主不保留副本：

| 能力 | 提供方 | 引用方式 |
|------|--------|----------|
| 基础 UI 原语 | `packages/ui-components` | `@fenix/ui-components/ui/<name>` |
| 通用业务组件 | `packages/ui-components` | `@fenix/ui-components/config/<name>` |
| 请求基建 | `packages/web-runtime` | `@fenix/web-runtime/api/request` |
| 组织/会话上下文**契约** | `packages/web-runtime` | `@fenix/web-runtime/contexts/org-session` |
| 资源域 API / 页面 / i18n | 各 owner 包 | `@fenix/<pkg>/web`、`@fenix/<pkg>/web/i18n` |

> 历史上宿主曾持有 `src/contexts/`（OrgContext）、把 `src/api/` 当作 API 建模层、以及 `apps/web/components/{ui,config}/` 的组件副本。这些已随 §1.6 T11e 收口删除或改由包提供——**新增能力时不要再往宿主放这些目录**。

### 1.2 包边界与引用纪律

- 跨包引用一律经对方 `package.json` 的 `exports`；**禁止**绕过出口深引 `@fenix/<pkg>/src/*` 或 `@fenix/<pkg>/web/src/*`。由 `package-no-internal-imports` 规则阻断（见 11.2）。
- 每个包的 `./web` 出口是**浏览器安全入口**：其值导入图里不得出现 `node:` 内建、`@server/*` 或 `@fenix/chat-channel/server`。由各包 `web/__tests__/*-browser-surface.test.ts` 静态守护（见 11.2）。
- 包根 `./web` 是默认出口，导出面按**包外真实消费点**收敛；未出现第二个消费者前不导出（内部视图的 props 形状不应变成对外契约）。确需跨包少量复用时才单开窄口（如 `@fenix/agent-runtime/web/api/environments`），并在该包 `exports` 显式声明。
- 能力按**归属**落位：接口对应哪张表、哪个 owner，域模块就放在那个包。宿主 `apps/web/src/api/` 只收容**无资源包归属**的宿主专有域（当前为 `branding` / `fs` / `instances` / `peri-task-details` / `helpers`）——既不要把资源域接口放进来，也不要把宿主专有域强行下沉。
- 跨包外键只允许在 `db/**` 的**组装期**导入对方表对象（Drizzle `.references()` 只接受列对象）；`src/**`、`web/**` 的调用期跨包读表一律违规。

### 1.3 路径别名纪律

别名只保留**宿主自有**目标（指向 `apps/web/src/**` 与 `apps/server/src/**`）。**禁止新增指向 `packages/**` 的别名**——它会让"包内实现"在宿主侧留下一个永不过期的写法，消费方必须改经各包 `exports`（包根 `./web` 或 `./web/lib/*` 窄口）。

`apps/web/vite.config.ts` 的 `alias` 与根 `tsconfig.json` 的 `paths` **两张表必须逐条一致**：

- vite 表决定构建期解析，根 `tsconfig.json` 表是 dependency-cruiser 的判定基准（`scripts/check-dependency-boundaries.ts` 以仓库根为 cwd 运行）。
- 两表不一致会产生最难查的一类问题：门禁能解析、生产构建解析不到。删改别名时必须同批改两张表。
- `@/src/i18n/locales` 必须排在 `@/src/i18n` 之前（vite 按声明顺序取首个匹配），否则字典目录会被 i18n 单例吃掉。

## 2. 路由与导航

使用 TanStack Router（file-based routing），`apps/web/src/routes/` 下文件自动映射为 URL。

### 2.1 文件命名约定

| 语法 | 含义 | 示例 |
|------|------|------|
| `_panel` | 布局片段（不贡献 URL 段） | `_panel.tsx` → 所有 `/agent/*` 共享布局 |
| `$param` | 动态路径参数 | `chat.$agentId.tsx` → `/agent/chat/:agentId` |
| `_` 后缀 | 分隔相邻动态参数 | `chat.$agentId_.$sessionId.tsx` |

新增页面：**路由壳**在 `apps/web/src/routes/agent/_panel/` 下创建 `.tsx` 文件，**页面实现**放 owner 包的 `web/pages/`，由路由壳懒加载引入（见 2.4）。宿主 `src/pages/` 只放宿主专有页面（如 `LoginPage`）。

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

路由壳只做懒加载与边界，**页面实现放在 owner 包**，壳里不写业务逻辑：

```tsx
// apps/web/src/routes/agent/_panel/models.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() => import("@fenix/model-management/web").then((m) => ({ default: m.AgentModelsPage })));

export const Route = createFileRoute("/agent/_panel/models")({
  component: () => (
    <Suspense fallback={<PageLoading />}>
      <Page />
    </Suspense>
  ),
});
```

**禁止**用相对路径穿透到包内文件（如 `import("../../../pages/agent-panel/pages/X")`）——那是包内实现，须经包 `exports` 进入（见 1.2）。

### 2.5 侧边栏

导航项由**各资源包**在 `packages/<pkg>/web/contribution.ts` 声明——`WebNavigationItem` 数组，每项含 `id`（映射到路由 `/agent/:id`）、`groupId`、`order`（组内顺序，组内必须唯一）、`ns` / `labelKey`（i18n key 与它所属的包字典）、`icon`（lucide-react 组件）；契约与判据见 `@fenix/web-runtime/shell/contribution`。

**分组与组间顺序由应用壳持有**（`apps/web/src/shell/shell-navigation.ts` 的 `SHELL_NAV_GROUPS`），资源包只声明自己属于哪一组、组内排第几——全局布局属于 Shell，资源模块不得反向决定。Shell 装配后由 `apps/web/src/shell/ShellNavigation.tsx` 渲染，并按服务端下发的 `hiddenTabs` 裁剪（只删项，不改序、不改分组）。

新增一个控制台页面需要：包内 `web/contribution.ts` 加一项 + 包字典补 `labelKey`，Shell 侧零改动（分组表不认识的新分组会在装配期直接报错，不会静默丢项）。

## 3. 状态管理

使用 **React Context + `useState`/`useCallback`**，不引入 Zustand/Jotai 等第三方状态库。

### 3.1 全局 Provider 与组织上下文

实际装配链见 `apps/web/src/routes/__root.tsx`：

```
<ThemeProvider>     ← 宿主主题管理（system/light/dark），来自 @/src/lib/theme
  <OrgProvider>     ← 身份包 @fenix/identity/web；在自身状态上投影出 OrgSession 后挂载 OrgSessionProvider
    <Outlet />
    <Toaster />
```

**组织/会话上下文是契约投影，不是宿主实现**：

- **契约**（形状 + 唯一 `createContext` 站点）在 `packages/web-runtime/web/contexts/org-session.tsx`，只声明资源包真正需要的粒度：`organizationId` / `userId` / `isOwner` / `pending`。全字段可空可假，**消费方必须自己处理未就绪态**。
- **实现**方是身份包的 `OrgProvider`——取数、切换与请求头注入属于身份域，不下沉到 `web-runtime`。资源包经 `useOrgSession()` 读取投影，不依赖身份包实现。
- 契约放在中性的 `web-runtime` 的原因：资源包需要组织上下文判断资源归属，但依赖矩阵禁止 `resources` 依赖具体平台实现。因此 `OrgSessionContext` 只能有**一个** `createContext` 站点——出现第二份会让资源包永远读到 `null`，而现象只是"权限判定全体失效"，很难从界面反推。
- 投影刻意不含身份域的角色枚举：`isOwner` 是资源包真实需要的粒度；更细的粒度按"第二个真实用例出现才抽象"补，不预留。

Context 必须使用守卫 hook 消灭 `undefined` 判断，且**不静默回落默认值**：

```tsx
export function useOrgSession(): OrgSession {
  const ctx = useContext(OrgSessionContext);
  if (!ctx) throw new Error("useOrgSession must be used within OrgSessionProvider");
  return ctx;
}
```

**禁止绕过上下文快照读取组织身份**（如 `localStorage.getItem("active_org_id")` 自行拼 `?active_org_id=`）。这类写法会制造"UI 显示 A、请求操作 B"的 split-brain。**target**（`docs/need-to-change/26`）：所有租户作用域请求、轮询 key 与 Y.Doc/session key 必须取自已提交的组织快照，且切换是一次原子状态转换。

### 3.2 数据获取

使用 **ahooks `useRequest`** 统一管理异步状态，禁止手写 `useCallback` + `useEffect` + `setState` 组合来管理数据获取。

```tsx
import { useRequest } from "ahooks";
import { taskV2Api } from "@fenix/resource-task/web";
import { unwrap } from "@fenix/web-runtime/api/request";

// 查询：自动管理 loading / error / data 三态
const { data, loading, error, refresh } = useRequest(() => unwrap(taskV2Api.list()));

// 变更：manual 模式，手动触发
const { run: createTask, loading: creating } = useRequest(
  async (body: TaskV2CreateBody) => unwrap(taskV2Api.create(body)),
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

> **必须 `unwrap()` 或显式判断 `success`**：域模块返回 `ApiResponse`，`request()` 对 HTTP/业务失败**返回 `{success:false}` 而不 throw**，而 `useRequest` 的 `error`/`onError` 只理解 rejected Promise——直接 `await` 会把 4xx/5xx 当成成功，继续推进 loading/empty 状态。这条双语义是在途项（见 5.2），在其收口前不得省略解包。

**优势**：自动处理 loading/error/data 状态、请求去重、防竞态（`loading` 期间不重复触发）。消除组件中散落的 `useState(loading)`、手动 `try/catch/finally` 和 Effect 依赖管理。

**缓存配置**：

```tsx
const { data, loading, refresh } = useRequest(() => unwrap(taskV2Api.list()), {
  cacheKey: "tasks-list",       // 跨组件共享缓存，同 key 的 useRequest 共享同一份数据
  staleTime: 60_000,            // 60s 内视为新鲜，不重新请求
  cacheTime: 300_000,           // 5min 后清除缓存
  retryCount: 2,                // 失败自动重试 2 次
  retryInterval: 2000,          // 重试间隔 2s
  refreshDeps: [orgId],         // 依赖变化时自动重新请求
  ready: !!orgId,               // 条件查询：orgId 存在时才发起请求
  debounceWait: 300,            // 搜索输入防抖 300ms
});
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
  // ahooks 已自动丢弃过期响应（latest-promise-wins），无需手动 AbortController
  async (query: string) => unwrap(someApi.search(query)),
  { manual: true, debounceWait: 300 }
);
// cancel() 可主动取消当前进行中的请求
```

> **target**（`docs/need-to-change/27`）：组件卸载或资源/租户切换时，必须显式取消仍在途的请求（交给 `cancel()` 或持有的 `AbortSignal`），不能只依赖 ahooks 的过期响应丢弃——轮询场景尤其如此，见 3.3。

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

- **`useRef` 防重连**：事件订阅类 hook 用 `useRef` 持有稳定引用，生成稳定 `useCallback`，避免 `useEffect` 因回调变化反复订阅/取消。
- **AbortController**：长轮询/重试场景在每次重试前 abort 上一次未完成请求，防止竞态。
- **表单使用 react-hook-form**：`useForm` + `zodResolver`，不手写 `useState` 管理表单状态。命名约定：`form = useForm<FormValues>(...)`、`formSchema = z.object({...})`。
- **Chat 状态 hook 有归属**：`useChatState` / `useSessionState` 定义在 `packages/agent-runtime/web/hooks/`，`use-page-visible` 定义在 `packages/web-runtime/web/hooks/`。宿主 `src/hooks/` 只放宿主自有 hook，不要在这里复制包内实现。
- **异步工作必须绑定 identity + generation**（**target**，`docs/need-to-change/27`）：资源或租户切换时立即取消上一 scope 的请求；响应只有 identity + generation 仍匹配时才能提交状态；轮询 single-flight 且页面隐藏时暂停。禁止用共享的 `intervalRef` 跨资源复用轮询、禁止把失败映射成 empty。

## 4. 组件规范

**已有组件禁止重复开发**。基础 UI 原语在 `packages/ui-components/web/ui/`（Button、Input、Select、Dialog、Tabs、Skeleton 等，经 `@fenix/ui-components/ui/<name>` 引用），通用业务组件在 `packages/ui-components/web/config/`（经 `@fenix/ui-components/config/<name>` 引用）——直接使用，不手写替代品。

**归属原则**：通用 UI 与业务组件归 `@fenix/ui-components`，宿主与资源包都不保留副本。归属由**消费者集合**决定：出现第二个包消费时就下沉到 `ui-components`，而不是在消费方各留一份；只有一个消费者时留在原处，不做推测性抽象。

### 4.1 通用业务组件

`packages/ui-components/web/config/` 下封装了项目统一的交互模式（经 `@fenix/ui-components/config/<name>` 引用）：

| 组件 | 用途 | 关键 props |
|------|------|------------|
| `FormDialog` | 通用表单对话框 | `open` / `onOpenChange` / `title` / `form` / `onSubmit` / `loading` |
| `ConfirmDialog` | 删除确认对话框 | `variant: "destructive"` / `onConfirm` / `loading` |
| `EmptyState` | 空状态占位 | `icon` / `title` / `description` / `action` |
| `StatusBadge` | 状态徽标 | `status` (string，通过 colorMap 映射颜色) |

目录内还有 `DataTable`、`BatchActionBar`，完整清单以 `packages/ui-components/web/config/` 的实际导出为准（不在此手工维护列表）。

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
import { FormDialog } from "@fenix/ui-components/config/FormDialog";

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
- **资源域类型**：跟随域模块定义在 owner 包的 `web/api/<domain>.ts`，经包 `exports` 导出（如 `TaskV2Info` 来自 `@fenix/resource-task/web`）。**不要在宿主重复声明一份**
- **宿主视图类型**：只服务宿主页面、无资源包归属的类型放 `apps/web/src/types/`
- **边界转换**：协议 DTO、领域对象与视图模型在边界处独立转换，不做跨层共享可变结构；前端类型必须对应后端真实返回，**禁止声明后端不存在的"幻影字段"**

### 4.6 文件结构

```tsx
// 1. React / 框架
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

// 2. 路由
import { Link, useNavigate } from "@tanstack/react-router";

// 3. 第三方 UI 库
import { Bot, Plus, Search, Trash2 } from "lucide-react";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";

// 4. 跨包能力（经各包 exports，不用别名）
import { TASKS_V2_NS } from "@fenix/resource-task/web/i18n";
import { taskV2Api } from "@fenix/resource-task/web";
import { unwrap } from "@fenix/web-runtime/api/request";

// 5. i18n
import { useTranslation } from "react-i18next";

// 6. 类型（按需）
import type { TaskV2Info } from "@fenix/resource-task/web";

export function AgentTasksPage() {
  const { t } = useTranslation(TASKS_V2_NS);
  // ...
}
```

### 4.7 文件规模与模块拆分

- **单个文件不得超过 500 行**。接近上限时应重构模块边界，而不是继续追加；生成文件豁免（如 `routeTree.gen.ts`）。
- 拆分按**职责**切，不按行数切：一个文件对应一个稳定职责与对外形状。"页面 + 数据编排 + 传输适配"挤在一个文件里是超限的常见成因。
- 收益判据是耦合而非行数：拆出的模块若仍需反向读取原文件内部状态，说明缝切错了——应先抽状态归属，再拆渲染。

## 5. API 建模层

前端对后端的 HTTP 调用统一经 `@fenix/web-runtime/api/request` 的 `request<T>()`；域模块按**资源归属**定义在 owner 包的 `web/api/` 下。

### 5.1 分层与归属

| 层 | 位置 | 职责 | 引用方式 |
|----|------|------|----------|
| 请求基建 | `packages/web-runtime/web/api/request.ts` | credentials、header 注入、序列化、超时、重试、错误标准化 | `@fenix/web-runtime/api/request` |
| 域模块 | `packages/<group>/<pkg>/web/api/<domain>.ts` | URL 拼装、请求/响应序列化、域内类型 | `@fenix/<pkg>/web` |
| 宿主专有域 | `apps/web/src/api/<domain>.ts` | 只服务宿主、无资源包归属的接口 | `@/src/api/<domain>` |
| 组件 | — | 调用域模块 → 处理结果 → 更新 UI | — |

- **归属判据**：接口对应哪张表、哪个 owner，域模块就放在那个包（见 1.2）。
- 宿主 `apps/web/src/api/` **不是**"API 建模层"，只是无资源包归属的宿主专有域收容处，当前为 `branding` / `fs` / `instances` / `peri-task-details` / `helpers`。
- **组件负责**：调用域模块 → 处理结果 → 更新 UI。不写 `fetch`、不拼后端 URL。
- **域模块负责**：URL 拼装、请求/响应序列化、域内类型定义。
- **窄口**：默认经包根 `./web` 出口；确需跨包少量复用时单开（现仅 `@fenix/agent-runtime/web/api/environments`），须在该包 `exports` 显式声明，且导出文件必须是浏览器安全入口（见 1.2）。

### 5.2 共享请求基建契约

实现见 `packages/web-runtime/web/api/request.ts`。**本节只描述契约，不复制实现**——实现会变，契约才是约束。历史上本节内嵌过实现副本，结果是文档里留下了一个真身注释明确点名为错误的写法（`json.data ?? json` 在 `data === null` 时错误回退整个响应对象，导致调用方收到非 null 值）。要么读真身，要么只读本节。

#### 导出面（**current**）

| 导出 | 作用 |
|------|------|
| `request<T>(url, options)` | 统一请求函数，返回 `Promise<ApiResponse<T>>` |
| `unwrap<T>(resp)` | 解包 `ApiResponse`：成功返回 `data`，失败抛 `ApiError` |
| `ApiError` | 统一错误类，携带 `code` / `data` 便于上层分类处理 |
| `ApiResponse<T>` | `{ success, data?, error?: { code, message, data? } }` |
| `PaginatedResponse<T>` | `{ items, total, page?, pageSize? }`——`page`/`pageSize` 可选，并非所有分页端点都返回 |
| `ErrorCode` | `KnownErrorCode \| (string & {})`，兼容后端透传的自定义业务错误码 |
| `WRITE_TIMEOUT_MS` / `UPLOAD_TIMEOUT_MS` | 均为 120s，与后端 file_op / upload 对齐 |

#### `RequestOptions` 字段（**current**）

| 字段 | 语义 |
|------|------|
| `params` | 路径参数 `:id` 插值 |
| `query` | 查询参数自动拼装 |
| `body` | 普通对象走 JSON，`FormData`/`Blob` 直传 |
| `timeout` | 超时 ms，默认 30000 |
| `signal` | 外部取消信号，与内部超时信号合并 |
| `opId` | 文件写操作幂等 ID，透传 `X-File-Op-Id`（`docs/arch/12-files.md` §7.2）；重试须复用同一 opId，服务端据此去重 |
| `bearerToken` | 注入 `Authorization: Bearer`（如系统 Master Key，`docs/arch/21` §5）；不设置时行为不变 |
| `headers` | 请求头透传（如 `If-None-Match` 条件请求）；与内部注入头合并，**冲突以本字段为准** |

> `headers` 是显式声明的字段而非 `...init` 透传：`RequestOptions` 用 `Omit<RequestInit, "body" \| "headers">` 关掉了这两个键，内部必须头（`content-type` / `x-file-op-id` / `authorization`）不会被调用方意外覆盖。新增内部头时保持这个结构，不要退回 `...init` 覆盖。

#### 失败语义（**transitional**，`docs/need-to-change/25`）

**现状是双语义**，这是当前最容易踩的一条：

- `request()` 对 HTTP 失败（4xx/5xx）与业务失败（`success === false`）**返回 `{ success: false, error }`，不 throw**。
- `unwrap()` 负责把失败转成 `throw ApiError`。
- 因此**直接 `await request()` 并依赖 `catch` / `onError` 的代码会把 4xx/5xx 当成成功**——`useRequest` 的 `error` / `onError` 只理解 rejected Promise。

**过渡期强制要求**：调用方必须 `unwrap()` 或显式判断 `success` 后再使用数据；不得省略解包，也不得新增依赖 `catch` 的调用点。

**target**（25 号）：默认域 client 返回已解包数据，HTTP / 业务 / 解析 / 超时 / 网络统一抛结构化 `ApiError`；需要 Result 的冲突与条件请求改用**显式命名的独立 interface**，不与默认请求混用；随后删除双语义入口，不留 deprecated shim。

**已知未修（截至 2026-09-22，均属 25 号范围）**：

- `request()` 的 catch 块注释承诺"网络错误/超时自动重试 1 次并复用同一 opId"，**实现里没有第二次执行**——注释与行为不一致。
- 超时定时器在收到响应头后即清除，**不覆盖 body 消费**，慢 `json()` / `text()` 不受超时约束。
- `anySignal` 合并后的监听器在请求成功后不移除，会挂在调用方的 `signal` 上直到其 abort。

引用这些行为时**以代码为准**，不要把注释或本节当作承诺。

#### 其它约定（**current**）

- **超时下限**：写操作的请求超时不得短于后端（file_op 60s / upload 120s），否则慢写会被前端提前掐断；需要区分时用 `WRITE_TIMEOUT_MS` / `UPLOAD_TIMEOUT_MS`。
- **错误码归一化**：后端用 snake_case 类型名（`not_found`、`validation_error`、`remote_error`），部分模块直接透传 `ErrorCode` 常量——`request()` 统一归一化，未提供时按 HTTP status 兜底映射。
- **错误记录但不弹 UI**：`request()` 用 `console.error` 记录失败，**不调 `toast`**——UI 反馈是组件职责（见 5.8）。
- **非 JSON 响应**：`content-type` 非 JSON 时通常不解析 body，但会试探性按 JSON 解析（后端在 FormData 上传响应上可能漏 `Content-Type`）；200 且既非 JSON 又无 `success` 字段时返回 `SERVER_ERROR`，不静默当成功。

### 5.3 非标准响应适配

部分后端接口不走标准 `{ success, data }` 包装，**在域模块内完成适配**，不让组件看到原始形状：

| 形态 | 出现处 | 适配方式 |
|------|--------|----------|
| `{ ok: true }` 无 `data` | knowledge-models、prod-views 的部分动作 | `request<{ ok: true }>()` 后归一为 `void` 或布尔 |
| 业务体自带 `ok: boolean` | providers 的连通性测试 | 保留 `ok` 字段，或映射到 `success` 语义 |
| 裸 `{ key }`（无 `data` 字段） | identity `web/lib/password-crypto.ts` 取登录加密公钥 | `request<{ key }>()` 后显式判 `success`（无 `data` 字段时整包即 `data`） |
| 二进制响应（下载） | `apps/web/src/api/fs.ts`（文件 / ZIP）、skill `web/api/skills.ts`（`download`）、observer `web/api/system-logs.ts`（`downloadSystemLog` 日志流） | **当前能力缺口**：需 blob 语义，暂用裸 `fetch` 兜底；域模块把成功响应收成 `Blob` 交回调用方、失败归一为 `ApiError`（code 与 `unwrap()` 同源），不让组件看到原始 `Response`。skill 的 `download` 已由裸 `Response` 改为 `Blob`（对外契约变更，经包 `web/index.ts` 导出） |
| 二进制 / 文本读 | knowledge `web/api/knowledge-bases.ts`（文本 / 二进制 / PDF 探测） | **当前能力缺口**：响应体即文件本体，暂用裸 `fetch` 兜底 |
| 文本 / 流式读（Bearer 鉴权） | sandbox `web/src/api/system-sandbox.ts`（`downloadTunnelConfig` / `getDiagnostics` / `executeCommand`：toml、诊断文本与命令 SSE 流） | **当前能力缺口**：端点直接回文本或流，非 `{ success, data }` 信封，暂用裸 `fetch` 兜底；三处只带 `Authorization: Bearer`——`/api/system/*` 的守卫只读该头（`apps/server/src/plugins/system-api-auth.ts`），不送 cookie |
| 上传进度 | `apps/web/src/api/fs.ts`（`uploadFiles`） | **当前能力缺口**：需进度回调，暂用 `XMLHttpRequest` 兜底 |
| 条件请求（`If-None-Match` → 304 + 读回 `ETag`） | `apps/web/src/api/fs.ts`（`revalidateWorkspaceTree`） | **当前能力缺口**：`request()` 不暴露响应头、304 非 2xx 无法与失败区分，暂用裸 `fetch` 兜底 |
| WebSocket / SSE | 非 REST 协议，如 workflow `web/api/workflow-sse.ts` 的 `EventSource` | 不走 `request()`，见第 8 章 |
| better-auth 客户端 | identity `web/lib/auth-client.ts`（`authClient.*`）及其 `/api/auth/sign-up/phone` | **库契约例外**：传输由库内 `createFetch` 持有，`request()` 无法插入该链路；库内核路由一律用客户端方法，自定义路由（无客户端方法）保留手写请求 |

> **observer 下载适配现状**：`downloadSystemLog` 仍走裸 `fetch`，并在域模块内自建失败归一（401/403 → `UNAUTHORIZED`，信封缺失时按状态码兜底，与 `unwrap()` 取同一处信封码）；成功侧只回 `Blob`，建锚点与 `revokeObjectURL` 已归调用方（observer `web/pages/admin/AdminLogsPage.tsx`），域模块内不再有 DOM 操作。它同样属**当前能力缺口**，随 `request()` 的 blob / 流能力收口后整体退回 `request()` + `unwrap()`。

> **两类例外的性质不同，不要混用**：「**当前能力缺口**」是 `request()` 的实现缺失（已记入审查报告），**修法是给 `request()` 补能力，不是在调用点继续手写**，由 `docs/need-to-change/25` 或后续补能力时收口；「**库契约例外**」是协议面本身不经 `request()`（better-auth 内核路由、SSE），`request()` 补齐后也不应改写。**新增这类调用点必须同时在本节登记**，未登记的手写 `fetch` / `XMLHttpRequest` 仍按 §5.8 违规处理。

### 5.4 域模块标准模式

域模块从 `@fenix/web-runtime/api/request` 取 `request` 与类型，**返回 `ApiResponse` 交给消费方解包**：

```ts
// packages/resources/task/web/api/tasks-v2.ts
import type { PaginatedResponse } from "@fenix/web-runtime/api/request";
import { request } from "@fenix/web-runtime/api/request";

export interface TaskV2Info { /* 域内类型跟随模块定义，不散落到宿主 */ }

export const taskV2Api = {
  /** 分页列表 */
  list: (query?: { page?: number; pageSize?: number; keyword?: string }) =>
    request<PaginatedResponse<TaskV2Info>>("/web/tasks/v2", { query }),

  /** 获取单个 */
  get: (id: string) => request<TaskV2Info>("/web/tasks/v2/:id", { params: { id } }),

  /** 创建 */
  create: (body: TaskV2CreateBody) => request<TaskV2Info>("/web/tasks/v2", { method: "POST", body }),

  /** 更新 */
  update: (id: string, body: Partial<TaskV2CreateBody>) =>
    request<TaskV2Info>("/web/tasks/v2/:id", { method: "PUT", params: { id }, body }),

  /** 删除 */
  del: (id: string) => request<void>("/web/tasks/v2/:id", { method: "DELETE", params: { id } }),
};
```

> **约定不统一处（**current** 偏离，已记入审查报告）**：按 §5.6 登记的口径清点，33 个域模块里 9 个在模块内部就 `unwrap` 了——宿主 `apps/web/src/api/fs.ts`、`apps/web/src/api/peri-task-details.ts`、`model-gateway`、`observer`、`system-logs`、`system-people-tree`、`hindsight`，以及 sandbox 的 `web/src/api/system-organizations.ts`、`web/src/api/system-sandbox.ts`；其余 22 个按上面的模式返回 `ApiResponse` 交给消费方（另 2 个本就不经 `request()`：`helpers.ts` 是纯工具、`workflow-sse.ts` 走 `EventSource`）。新增模块**按上面的模式返回 `ApiResponse`**，不要在域模块内提前解包——解包归属要一次性决定（随 `docs/need-to-change/25` 收口），现在混用只会让调用方无法从签名判断拿到的是数据还是 Result。

### 5.5 域模块命名与组织

| 规则 | 说明 | 示例 |
|------|------|------|
| 文件名 kebab-case | 与资源域一致 | `knowledge-bases.ts`、`workflow-defs.ts` |
| 导出对象 camelCase + `Api` 后缀 | 避免与类型名冲突 | `taskV2Api`、`mcpApi`、`kbApi` |
| 位置跟随 owner 包 | `packages/<group>/<pkg>/web/api/` | `packages/resources/skill/web/api/skills.ts` |
| 由包 `./web` 出口转出 | 导出面按包外真实消费点收敛（见 1.2） | `export * from "./api/tasks-v2"` |
| 非 REST 传输与域模块同层 | 不塞进 `request()` | `workflow-sse.ts` |

> 包布局有一处历史差异：`agent-config` 同时存在 `web/api/` 与 `web/src/api/`，`sandbox` 用 `web/src/api/`。新增包一律放 `web/api/`——`web/src/**` 是被 `package-no-internal-imports` 判定为包内实现的路径，不应作为域模块出口。

### 5.6 域模块一览

| owner 包 | 域模块 | 说明 |
|----------|--------|------|
| `@fenix/web-runtime` | `web/api/request.ts` | 请求基建（非域模块） |
| `@fenix/agent-runtime` | `environments.ts` | 环境与实例；**窄口** `@fenix/agent-runtime/web/api/environments` |
| `@fenix/identity` | `api-keys.ts`、`organizations.ts` | API Key 与组织 |
| `@fenix/agent-config` | `agents.ts`、`sites.ts`、`web/src/api/sidebar-config.ts` | Agent 配置、站点、侧栏配置 |
| `@fenix/model-management` | `providers.ts`、`models.ts`、`model-gateway.ts` | Provider、模型、模型网关 |
| `@fenix/resource-skill` | `skills.ts` | Skill 元数据与内容 |
| `@fenix/resource-mcp` | `mcp.ts` | MCP server |
| `@fenix/resource-knowledge` | `knowledge-bases.ts`、`knowledge-models.ts` | 知识库与嵌入模型 |
| `@fenix/resource-task` | `tasks-v2.ts` | 定时任务（v2） |
| `@fenix/resource-workflow` | `workflows.ts`、`workflow-defs.ts`、`workflow-engine.ts`、`workflow-sse.ts` | 工作流定义、引擎、SSE |
| `@fenix/resource-channel` | `channels.ts` | IM 通道 |
| `@fenix/resource-machine` | `registry.ts` | 机器注册表 |
| `@fenix/resource-memory` | `hindsight.ts` | 记忆 |
| `@fenix/resource-observer` | `observer.ts`、`system-logs.ts`、`system-people-tree.ts` | 观察面板与系统日志 |
| `@fenix/resource-prod-view` | `prod-views.ts` | 生产视图 |
| `@fenix/resource-sandbox` | `web/src/api/{sandbox-pools,system-organizations,system-sandbox}.ts` | 沙箱与系统组织 |
| 宿主 `apps/web/src/api/` | `branding.ts`、`fs.ts`、`instances.ts`、`peri-task-details.ts`、`helpers.ts` | 宿主专有域（无资源包归属） |

按 owner 归属维护，**不记录接口数量**（会漂）。新增域模块时同步本表。

### 5.7 组件中使用

组件不直接 `await` 域模块，统一交给 ahooks `useRequest`，并用 `unwrap()` 解包：

```tsx
import { useRequest } from "ahooks";
import { taskV2Api } from "@fenix/resource-task/web";
import { unwrap } from "@fenix/web-runtime/api/request";

// 查询：自动管理 loading / error / data，组件挂载时自动执行
const { data, loading, error, refresh } = useRequest(() => unwrap(taskV2Api.list({ page: 1, pageSize: 20 })));

// 变更：manual 模式，手动触发，成功后刷新列表
const { run: saveTask, loading: saving } = useRequest(
  async (body: TaskV2CreateBody) => unwrap(taskV2Api.create(body)),
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

**强制规则**：`console.error` 必须与 `toast.error` 配对，确保错误可追踪。静默失败仅用于后台刷新等非关键路径——**不得用于抑制真实失败**（把失败映射成 empty 或成功状态是 25、27 号点名的缺陷形态）。

### 5.8 禁止事项

- **禁止**在组件中直接写 `fetch` / `XMLHttpRequest`，或在 `useEffect` 中裸调 `fetch`
- **禁止**在组件中拼装后端 URL
- **禁止**在域模块中重复定义 `request()`——统一从 `@fenix/web-runtime/api/request` import
- **禁止**在 API 模块内调用 `toast.error`（UI 层职责，错误由组件 `onError` 处理）
- **禁止**新增 `/v1`、`/v2` 历史前缀（由 `frontend-no-legacy-api-prefix` 规则阻断，见 11.2）
- **禁止**绕过包 `exports` 深引 `@fenix/<pkg>/src/*`、`@fenix/<pkg>/web/src/*`（见 1.2）
- **禁止**直接 `await` 域模块并依赖 `catch`（双语义期必须解包，见 5.2）

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

**已登记的显式例外（`current` 偏离，用户裁定保留，不得作为新代码先例）**：

- 系统 Master Key 存 `sessionStorage`（键 `rcs_admin_master_key`）：实现见 `packages/web-runtime/web/lib/admin-key.ts`，写入点在 sandbox 的 `web/src/pages/admin/components/MasterKeyGate.tsx`。master key 不进 better-auth 会话体系，落在标签页 session 内换取「刷新页面免重输」；代价是同源脚本与 XSS 可直接读走该值，因此**只允许服务系统管理员页**（sandbox / observer 的 master key 门），不得用于普通用户凭据。XSS 面由 §6.1 控制。
- **移除条件**：master key 改由服务端 HttpOnly Cookie 或仅内存态承载（接受刷新重输）后，删除 `admin-key.ts` 及其全部消费方，并同步删除本条登记。

### 6.3 敏感操作

- 删除、权限变更、组织转移等敏感操作**必须**经过二次确认（ConfirmDialog `variant: "destructive"`）
- 敏感操作的 API 调用**禁止**在 URL 中携带敏感参数（使用 POST body）

## 7. 错误边界

使用 React ErrorBoundary 防止单组件崩溃导致整个页面白屏。

### 7.1 放置规则

- **每个路由段**至少包裹一个 ErrorBoundary
- 独立功能面板（如 ChatPanel、ArtifactsPanel、Sidebar）各自包裹独立的 ErrorBoundary，一个面板崩溃不影响其他面板
- 顶层根布局需要一个兜底 ErrorBoundary

> **现状（本条基本未落地）**：全仓仅 `apps/web/src/routes/view/$prodViewId.tsx` 有局部 `ErrorBoundary`；根布局（`__root.tsx`）、`_panel.tsx`、`ChatPanel`、`ArtifactsPanel`、`AgentSidebar` **均未包裹**，统一 `ErrorFallback` 组件也不存在。下文的放置矩阵是 **target**，不是现状描述——新页面不要因为"反正都没有"继续省略，也不要以为既有页面已受保护。

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

**放置矩阵**（**target**：**尚无编号，需补登**，建议编号 `docs/need-to-change/44-contain-panel-crashes-with-error-boundaries.md`）：

| 层级 | 包裹范围 | ErrorBoundary 位置 | 关键/非关键 |
|------|----------|-------------------|------------|
| 根布局 | 整个应用 | `__root.tsx` 的 `RootComponent` 最外层 | 关键（兜底） |
| Agent 面板布局 | `_panel.tsx` 路由布局 | 包裹 `{children}` 出口 | 关键（Agent 页整体） |
| ChatPanel | 聊天交互面板 | `ChatPanel` 根组件 | 关键（核心功能） |
| ArtifactsPanel | 输出展示面板 | `ArtifactsPanel` 根组件 | 非关键（可降级） |
| Sidebar | 左侧导航 | `AgentSidebar` 根组件 | 非关键（可降级） |

- **关键** ErrorBoundary：降级 UI 占据原有的布局区域，提供明确的重试按钮
- **非关键** ErrorBoundary：可收缩为最小化状态（如一条错误提示条），不影响主内容区
- **target**：降级 UI 统一使用同一套 `ErrorFallback` 组件，通过 `variant: "full" | "compact"` 区分样式（该组件尚不存在，当前各处自写 fallback；与放置矩阵同属一项，**尚无编号，需补登**）

### 7.2 降级策略

- ErrorBoundary 的 `FallbackComponent` 必须提供**重试按钮**（调用 `resetErrorBoundary`）
- 降级 UI 不应改变页面布局结构，避免级联布局崩溃
- `onError` 回调中必须 `console.error` 记录原始错误，便于排查
- 错误边界捕获的错误不需要额外 `toast.error`（降级 UI 本身就是用户可见反馈）

## 8. WebSocket / 实时通信

前端与 Agent 实例通过 Yjs WebSocket（`/yjs-ws`）实时通信，客户端为 `createYjsWsClient`（`@fenix/chat-channel`），状态消费走 `useChatState` / `useSessionState`（双 Y.Doc：`chat:{rcsSessionId}` 时间线 + `session:{rcsSessionId}` 元信息）。服务端生命周期见 `packages/chat-channel/src/channel/gateway.ts` 与 `docs/arch/19-yjs-chat-streaming.md`。

### 8.1 连接生命周期

- **建立**：`gateway.handleOpen` 认证 → `ensureRunning` → 打开 Chat Doc / Session Doc → `relayReady = true` 前发送初始快照 → `connect` 握手 → flush 缓冲消息
- **断开**：`handleClose` 释放连接级资源与 relay 引用计数；Agent 实例存活时重连后由 `handleOpen` 重新同步实时 Y.Doc；`relay_closed`（实例断链）才销毁 Doc
- **心跳**：前端发 `ping` 探测（服务端回 `pong`）；`keep_alive` 标记页面可见性，服务端 30s 心跳，超时（约 60s 无客户端心跳）close 4501

### 8.2 重连策略

客户端自动重连，但**终态关闭码不重连**（须手动重试）：

| 关闭码 | 含义 | 前端行为 |
|--------|------|----------|
| 4500 | 机器离线 | 停止自动重连，展示 `machine_unavailable` 手动重试 |
| 4501 | 客户端 keepalive 超时（页面隐藏） | 停止自动重连，回可见时手动重连 |
| 4502 | spawn 永久拒绝（autoStart 关闭 / maxSessions 上限等） | 停止自动重连，按 `payload.code` 展示原因 |
| 1013 | 连接数超限 | 停止自动重连 |
| 其他 | 瞬时错误 | 自动重连 |

### 8.3 消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `action`（commandId 信封） | 前端 → 后端 | 会话操作（send_prompt / cancel / load_session 等），`commandId` 幂等去重 + `accepted → committed` 两阶段 Ack |
| `ping` / `keep_alive` | 前端 → 后端 | 心跳与可见性标记 |
| yjs 增量（`chat:` / `session:`） | 后端 → 前端 | 双 Doc 状态广播（消息时间线、会话元信息、权限、工具调用） |
| `action_ack` / `action_error` | 后端 → 前端 | 操作确认与稳定错误码 |
| `error` | 后端 → 前端 | 连接级错误（携带终态码对应 `payload.code`） |

### 8.4 前端 Chat 约束

以下约束共同保证刷新恢复、多标签页一致性与消息不重复，改动 Chat 相关代码前必须逐条确认：

- **用户消息只由后端写入 Y.Doc**。前端不得维护第二份 `localUserEntries` 之类的本地副本——否则 Agent 回显会造成双写。
- **`ChatView` 与 `EntryRenderer` 使用 `React.memo`**。comparator 必须与调用方的 prop 稳定性保持一致；改动 props 时同步更新 comparator 与相关渲染测试，否则会出现"消息不更新"或"整表重渲染"两类反向故障。
- **清理会话内容**用 `clearSessionDocContent` 在**原 Y.Doc 事务中**完成；禁止 destroy + recreate（会制造异步竞态）。`create_session` 同样必须先清空旧 Session Doc。
- **Y.Doc 命名固定**：`chat:{rcsSessionId}` / `session:{rcsSessionId}`；广播必须按 `rcsSessionId` 隔离，**禁止全局广播会话数据**。多实例场景必须传入 DB 会话 ID 以实现 Doc 隔离。
- **`rcsSessionId` 必须确定性生成**，不得使用 `Date.now()` 或随机值——否则刷新后旧 Y.Doc 不可达，表现为"历史消息丢失"。
- **多标签页共享 relay**：同一 `instanceId + userId` 共享一个 relay handle，引用计数归零后才释放；切换 session 时同步同组客户端的 `acpSessionId`。
- **重连恢复**：从 `chatMeta.activeSessionId` 恢复 `entry.acpSessionId`；同一 ACP session 的 `load_session` 必须跳过 Agent 全量回放。WebSocket open 时必须在 `relayReady = true` **之前**发送 Chat Doc 与 Session Doc 初始快照。
- **Agent status 到达前不得发送 `list_sessions`**；`session/list|new|load|resume` 的 `cwd` 由服务端 translator 注入，前端不传。
- **浏览器安全**：`@fenix/chat-channel` 根入口只导出类型、schema、`chat-writer`、`yjs-store`、`protocol`、`transport`、`util`；服务端能力（channel 控制面、persist、state 聚合层）必须走 `@fenix/chat-channel/server`。从根入口转出服务端模块会把 node 依赖打进浏览器 bundle（曾导致整包加载崩溃），边界由 `chat-channel-browser-surface.test.ts` 静态守护。
- **背压**：WebSocket 发送背压阈值为 64 KB（`YJS_MAX_CLIENTS` 默认连接上限 200）；修改时必须保留限流、资源释放与单连接故障隔离。

## 9. i18n 国际化

`react-i18next` + `i18next`，英文默认，中英双语。所有 TSX 文件无例外走 i18n。

### 9.1 使用

```tsx
import { useTranslation } from "react-i18next";
import { TASKS_V2_NS } from "@fenix/resource-task/web/i18n";

const { t } = useTranslation(TASKS_V2_NS);
t("form.name.label")                   // 点号分层
t("title")                             // 扁平 key
t("toast.saved", { name: item.name })  // 插值：双花括号
```

**插值必须用 `{{var}}`**。单花括号 `{var}` 会被 i18next 当作字面文本原样输出，是静默失败——界面上会出现裸露的 `{var}`。

### 9.2 新增命名空间

命名空间与词条**归属 owner 包**，宿主只做装配：

1. 在 owner 包内建 `packages/<group>/<pkg>/web/i18n/`，导出 `<DOMAIN>_NS` 与 `xxxResources`，并经该包 `exports["./web/i18n"]` 公开。
2. 宿主 `apps/web/src/i18n/index.ts` 只 import 各包的 NS 与 resources 并注册，**不在这里写域内词条**。
3. 消费方从包出口取 NS：`import { TASKS_V2_NS } from "@fenix/resource-task/web/i18n"`，不写字面量。
4. 只有真正跨资源包共用的词条才进 `@fenix/web-runtime/i18n/namespace`（`SHARED_NS`）或 `@fenix/ui-components/i18n/namespace`。

> 宿主自身的 `NS` 常量（`@/src/i18n`）只保留宿主专有命名空间与 `SHARED_NS` 展开；历史命名空间（如 `TASKS` / `SESSIONS` / `ENVIRONMENTS`）已随资源包收口删除，写 `NS.TASKS` 会取到 `undefined`。

### 9.3 规则

- 禁止在 JSX 中硬编码用户可见字符串
- 命名空间用包的 `NS` 常量，不写字符串字面量
- 中文注释和 `console.log` 不受 i18n 限制
- **en / zh 的 key 必须对称**；新增 key 时同批补齐两种语言
- **日期、数字、相对时间必须取当前 locale**，不得在共享组件中固定 `zh-CN`
- **API / domain 错误按稳定 error code 映射到 message key**；未知错误使用安全通用文案，**不展示 raw message**
- **纯逻辑模块与后端不得 import UI i18n 或图标依赖**

> **target**（`docs/need-to-change/41`）：i18n 是 ViewModel 契约，不是上线前搜字符串。目标态要求「所有用户可见文案、`aria-label`、toast、日期/数字/相对时间均来自当前 locale」「message key 多语言对称且插值参数可检查」「route/feature namespace 按当前语言懒加载」——当前首屏静态加载两种语言全部 namespace，且 key 对称只靠人工，尚无门禁。

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

`cn()` 仅限 `@fenix/ui-components` 的 `web/ui/` 基础组件使用，业务页面直接写 className 字符串。

### 10.2 图标

- **通用 UI 图标**：只用 `lucide-react`，禁止内联 SVG
- **AI 模型图标**：用 `<ModelIcon modelId="gpt-4o" size={16} />`，禁止直接 import `@lobehub/icons`
- **纯逻辑模块不得依赖 UI 图标包**（`lucide-react`、`@lobehub/icons` 等）。后端与纯逻辑测试同样不得**间接**加载它们——`@lobehub/icons` 的边界由 `model-icon-boundary` 规则强制（见 11.2）

### 10.3 字体

系统字体栈，禁止外部字体链接。

## 11. 开发落地清单

### 11.1 提交前自检

- [ ] **`bun run precheck` 通过**（format → import-sort → module-registry → web-contributions → owner-inventory → schema-ddl-drift → architecture → tsc(server / web / app skeletons) → dependency-boundaries → lint → server / script / package / web-app 测试）
- [ ] 用户可见字符串全部走 `t()`；插值用 `{{var}}`；en / zh key 对称
- [ ] 导航使用 `useNavigate()` / `<Link>`，未使用 `window.location` 写操作
- [ ] 新增页面：路由壳放 `apps/web/src/routes/agent/_panel/`，页面实现放 owner 包 `web/pages/` 并经懒加载引入（见 2.4）
- [ ] API 调用经域模块，且已 `unwrap()` 或显式判断 `success`；组件中无裸 `fetch`
- [ ] 跨包引用经各包 `exports`；未新增指向 `packages/**` 的别名；vite 与 tsconfig 两张别名表同步
- [ ] 单文件未超 500 行
- [ ] Loading 态有骨架屏守卫
- [ ] Empty 态有占位提示
- [ ] 表单使用 react-hook-form + zod，不手写 `useState` 校验
- [ ] Dialog `onOpenChange` 中清理状态
- [ ] 无 `dangerouslySetInnerHTML` 不经清洗使用
- [ ] 无 API Key / Token 存入 localStorage
- [ ] 独立面板包裹 ErrorBoundary（ChatPanel / ArtifactsPanel / Sidebar）
- [ ] 修改后执行 `bun run build:web`（后端从 `apps/web/dist/` 挂载静态资源，不可省略）

### 11.2 自动化检测

`bun run precheck` 的 `architecture` 阶段会扫描 TypeScript 静态 import / export / dynamic import 与前端 URL 字面量，当前自动阻断以下高置信规则（实现见 `scripts/check-architecture.ts`）：

| 规则 id | 约束 |
|---------|------|
| `browser-entry-server-import` | 浏览器生产代码不得导入 `node:*`、`@server/*`、`@fenix/chat-channel/server`；测试代码可使用服务端测试工具 |
| `package-no-internal-imports` | 跨 workspace 包不得绕过公开导出访问 `@fenix/*/src/*`、`@fenix/*/web/src/*` |
| `zod-v4-entrypoint` | Zod 必须从 `zod/v4` 导入 |
| `model-icon-boundary` | `@lobehub/icons` 只能由 model-management 的 `model-icon` 组件封装 |
| `frontend-no-legacy-api-prefix` | 经 `request()` 调用时不得使用 `/v1`、`/v2` 历史前缀 |
| `backend-no-route-imports` | （后端）Service / Repository 不得反向依赖 Route |

另有 `check:dependencies`（dependency-cruiser，读根 `tsconfig.json` 的 `paths`）与 `check:root-owner-inventory`、`check:schema-ddl-drift` 参与 `precheck`；各包的 `web/__tests__/*-browser-surface.test.ts` 静态走值导入图，守护浏览器安全入口。

工具链仍**不能**覆盖交互与语义规则。以下缺口建议逐步自动化，不靠人工 review 兜底：

| 规则 | 现状 | 对应在途项 |
|------|------|-----------|
| 组件中裸调 `fetch()` / `XMLHttpRequest` | 未自动化（本次审查发现多处，见 5.3） | 25 |
| 直接 `await` 域模块不解包 | 未自动化，签名层面无法区分 | 25 |
| `window.location` 写操作 | 未自动化（当前代码零命中） | 34 |
| `dangerouslySetInnerHTML` 不经清洗 | 未自动化 | 6 |
| `localStorage` 读写组织身份 | 未自动化 | 26 |
| 轮询 / mutation 未绑定 identity + generation | 未自动化 | 27 |
| 键盘操作与 ARIA（tree、icon-only button） | 无 axe / Playwright 门禁 | 28 |
| route gzip、初始 JS、请求次数预算 | 无 CI 预算 | 29 |
| i18n key 对称、单花括号模板、`[object Object]` | 无门禁 | 41 |
| `console.error` 缺配对 `toast.error` | 需语义分析，短期保持人工 review | — |
| import 分组顺序、格式化 | Biome（已覆盖） | — |

**pre-commit hook** 建议配置 lint-staged，在 `git commit` 时自动运行 `bun run precheck`。

