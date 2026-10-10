# 前端开发规范
> **版本**：v3.2.0 | **最后更新**：2026-09-24 | **维护者**：前端团队
>
> 只记**当前规则**与**尚未收口的偏离**；变更日志与已收口条目已删，历史见 `git log --follow -- docs/developer/guide/frontend-development.md`。

本文档约束 FenixAgent 主控制台前端。与 `CLAUDE.md` / `CONTRIBUTING.md` 冲突时以本文档为准，并同批修正另外两处。

## 0. 使用约定
### 0.1 适用范围
- **覆盖**：`apps/web/**`（宿主）与 `packages/**/web/**`（owner 包 web 面）。
- **不覆盖**：`ui-sandbox/`（独立设计沙盘，不在 workspace、不参与 `precheck`）、`packages/**/src/server/**` 与 `packages/chat-channel/src/server.ts`（归后端规范）。二者中的写法不是本规范的反例，也不要照抄。

### 0.2 规则与现状
- 只写**当前规则**——代码已按此实现、可据以 review 的不变量。各章末 **「现状偏离」** 只记尚未落地的位置，每条一行：`位置 — 移除条件`。
- **偏离不是许可**：不要照抄违规写法；收口后顺手删掉条目，本文档不积累历史。

## 1. 目录结构与包边界
`apps/web` 是唯一前端构建入口（React 19 + Vite + TanStack Router，挂 `/ctrl`），只提供应用壳；业务能力按**资源归属**分布在各 owner 包，经其 `exports` 暴露 web 面。UI 原语、请求基建、组织会话契约、资源域 API / 页面 / 字典、共享域类型一律由包提供，宿主不留副本。

宿主 `src/` 分工：`routes/` 路由壳 · `pages/` 宿主专有页面 · `shell/` 应用壳与侧栏装配 · `api/` 宿主专有域 · `components/` `hooks/` `lib/` `i18n/` `types/` `__tests__/`。

入口约定：`src/main.tsx` 是唯一启动入口；`src/index.css` 是 Tailwind v4 入口（token 与 `@source`，见 §10）；`fenix.module.ts` 是 `kind: "web-shell"` 描述符，**只允许 `import type`**；`src/routeTree.gen.ts` **入库、严禁手改**。

**路径前缀三处必须一致**：`vite.config.ts` 的 `base: "/ctrl/"`、`main.tsx` 的 `basepath: "/ctrl"`、服务端 `staticPlugin` 的 `prefix: "/ctrl"`。

三条硬规则：

- **引用一律经对方 `exports`**：禁止深引 `@fenix/<pkg>/src/*` 或 `@fenix/<pkg>/web/src/*`（`package-no-internal-imports` 阻断，见 §11.2）。
- **组件源码必须落在 `<pkg>/web/` 下**：宿主 Tailwind 的 `@source` 只扫 `packages/**/web/**`，放别处工具类会被**静默裁剪**（§10）；`web/` 同时是浏览器安全边界的判据目录（§11.2）。
- **导出面按真实消费点收敛**：没有第二个消费者就不导出；确需跨包复用时单开窄口，并在 `exports` 显式声明。

**归属按资源落位**：接口对应哪张表、哪个 owner，域模块就落那个包。宿主 `apps/web/src/api/` 只剩 `branding.ts` 一个宿主专有域（`file-events.ts` 与 `fs.ts` 归 `@fenix/resource-machine` 的 `web/api/`、`instances.ts` 归 `@fenix/agent-runtime`、`peri-task-details.ts` 归 `@fenix/model-management`、`helpers.ts` 已删除）。

包的 `./web` 出口形状不统一，改包前先看它的 `exports`：

| 出口形状 | 包 |
|------|-----|
| `./web` + `./web/contribution` + `./web/i18n` | `resources/*` 8 个（`agent-config` / `knowledge` / `mcp` / `memory` / `model-management` / `skill` / `task` / `workflow-v2`）与 `platform/identity`，与 `ce.json` 的 `web` 列表等长——该列表记的是 **web 贡献 id 而非包名**：`workflow` 这个 id 自 2026-09-29 起由 `@fenix/resource-workflow-v2` 贡献（id 沿用旧包，导航目标仍是 `/agent/workflow`） |
| 只有 `./web` + `./web/i18n`（个别另有 `./web/hooks/*` 等窄口），不在 `ce.json` 的 `web` 列表 | `channel` / `machine` / `observer` / `plugin-market` / `prod-view` / `sandbox` / `agent-runtime`（另有 `./web/api/{environments,instances}` 与 `./web/hooks/*` 窄口，**浏览器不得依赖其服务端根入口**） |
| 不走 `web` 前缀 | `ui-components`（根 barrel + 160 条子路径，深链优先）· `web-runtime`（`./api/request` 等）· `chat-channel`（无 web 面，根入口必须浏览器安全，见 §8.6） |

### 1.1 装配产物与构建

| 环节 | 事实 |
|------|------|
| 路由树 | `TanStackRouterVite` 插件在 dev/build 生成 `src/routeTree.gen.ts`，**无独立生成脚本**；改路由后必须跑一次 `dev:web` 或 `build:web` |
| 导航装配 | `scripts/generate-web-contributions.ts` 读 `deploy/assembly/ce.json` 的 `web` 列表 → `apps/generated/web-contributions.ts`；`generate:web-contributions --check` 进 CI |
| 模块注册 | `scripts/generate-module-registry.ts` → `apps/generated/module-registry.ts`，服务端 bootstrap 消费 |
| 产物保管 | `apps/generated/` **入库**（`biome.json` 排除格式化），是浏览器 bundle 的静态依赖；**换部署 profile 必须重跑 `build:web`** |
| 构建命令 | `bun run build:web` = `vite build --config apps/web/vite.config.ts`；生产开 `sourcemap` |
| 静态挂载 | `apps/server/src/plugins/static.ts` 从 `apps/web/dist/` 挂载；SPA fallback 依赖 `onError({ as: "global" })` + 显式 `set.status = 200` + 注册在 `errorPlugin` 之前 |
| chunk 分组 | `manualChunks` 10 组（shiki / mermaid / motion / vendor / ai-sdk / qr / radix-ui / tanstack-router / tanstack / hookform），改名或合并影响缓存与首屏 |
| 部署变量 | 打包部署必须设 `RCS_APPLICATION_ROOT`；Docker build 必须 `COPY apps/generated` |

### 1.2 路径别名纪律
- 别名只保留**宿主自有**目标（`apps/web/src/**`、`apps/server/src/**`）；**禁止新增指向 `packages/**` 的别名**。
- 三张表分清归属：`apps/web/vite.config.ts` 的 `resolve.alias`（构建期，5 条前缀式键）· 根 `tsconfig.json` 的 `paths`（前端类型检查 + **dependency-cruiser 判定基准**，5 条路径键）· `tsconfig.base.json` 的 `paths`（服务端与包，12 条 `@fenix/*`）。**`apps/web` 看不到第三张表**（`paths` 整体替换而非合并）。
- vite 表与根 `paths` 表**必须逐条对应**，删改必须同批改两张——只改一张会造出「门禁能解析、生产构建解析不到」的问题。
- `@/src/i18n/locales` 必须排在 `@/src/i18n` 之前（vite 按声明顺序取首个匹配）。
- 有 6 个包自建包内别名表（acp-link / agent-runtime / chat-channel / agent-config / ui-components / web-runtime），只服务包自身。

### 1.3 现状偏离
- 浏览器安全入口守卫未覆盖全部带 web 面的包（13 份守卫全在 `packages/resources/*`；`platform/identity`、`ui-components`、`web-runtime`、`agent-runtime` 无守卫）— 各自补齐守卫后删除本条。

## 2. 路由与导航
TanStack Router（file-based）：`apps/web/src/routes/` 下文件由 Vite 插件映射为 URL，产物 `src/routeTree.gen.ts` **入库且严禁手改**。应用挂 `/ctrl` 前缀，`main.tsx` 的 `basepath` 与 `vite.config.ts` 的 `base` 必须同改。

### 2.1 文件命名约定

| 语法 | 含义 |
|------|------|
| `_panel` | pathless 布局片段，不贡献 URL 段（只管 `/agent/<面板页>` 与 `/agent/chat/*`） |
| `$param` | 动态路径参数：`_panel/chat.$agentId.tsx` → `/agent/chat/$agentId` |
| `_` 后缀（动态段） | 分隔相邻动态参数：`chat.$agentId_.$sessionId.tsx` |
| `_` 后缀（静态段） | 阻止后续段成为前一段的子路由：`workflow_.$id.edit.tsx`（否则 `$id` 会挂到 `workflow.tsx` 下） |

`/agent/$agentId` 与 `/agent/$agentId/$sessionId` 是 **rootRoute 的兄弟**，不受 `_panel` 布局包裹——它们只有 `beforeLoad` + `throw redirect` 的旧 URL 重定向桩，**不声明 `component`**。

### 2.2 路由参数
```tsx
const { agentId } = Route.useParams();                            // 路由壳内
const { prodViewId } = useParams({ from: "/view/$prodViewId" });  // 跨包：宿主 route id 是契约
const search = useSearch({ strict: false }) as { runId?: string }; // 宿主未声明 validateSearch
```

包内页面读宿主动态段必须用带 `from` 的形式——此时**宿主的 route id 成为跨包契约**，改宿主路由要同步搜跨包引用。`useSearch({ strict: false })` 的断言**不做运行时校验**，新增查询参数要自己兜底默认值。

### 2.3 鉴权与重定向
- **全局守卫只有一处**：`apps/web/src/routes/__root.tsx`，用 `useEffect` + `navigate` 实现（不是 `beforeLoad`），决策表在 `apps/web/src/shell/session-guard.ts`（有单测）——会话未就绪渲染 spinner；疑似未登录（非 `/login` 非 `/admin`）先延迟复核一次会话再跳 `/login`（复核期间渲染 spinner），复核命中会话则不跳；已登录访问 `/login` 跳 `/agent`。**守卫的两个跳转（`/login`、`/agent`）一律 `replace`**：会话判定在「有/无」之间抖动时（如浏览器存量 cookie），即时跳转会让两侧互跳成 `/ctrl/login ↔ /ctrl/agent` 死循环。**复核计时器必须挂 `ref`**（不随 effect 清理）：重定向抖动会让 `pathname` 以毫秒级节奏变化，计时器若绑在 effect 生命周期上会被反复清掉重排，复核永远完不成、守卫永远不跳登录页——「复核」是挡住单次 null 的闸门，不得删，也不得让它可被路径抖动取消。
- **入口 `/` → `/agent` 必须用 `beforeLoad` + `throw redirect`**（`apps/web/src/routes/index.tsx`），不得写成组件里的 `useEffect(navigate)`：入口匹配在 `/agent` 完成重定向前**仍是已提交的匹配**，过渡期间的重新挂载会把导航 effect 再跑一遍；`/agent` 又被它自己的 `beforeLoad` 换成 `/agent/home`，于是 URL 在 `/ctrl/agent ↔ /ctrl/agent/home` 之间以毫秒级节奏互跳——每次导航都顶掉上一次尚未提交的 load，循环自己停不下来（实测：真实产物里 4ms 内跳 6 次，浏览器里可持续数秒）。`beforeLoad` 每次 load 只执行一次、不随 React 提交重跑，因此不存在这条反馈回路。守卫是唯一例外：它按 `pathname` 条件边沿触发（跳 `/login`/`/agent` 后条件立即不再成立），重挂载不会重复生效。
- `/admin` **豁免 better-auth 会话**，由页面内 `AdminKeyGate`（`@fenix/ui-components/config/AdminKeyGate` 配 `@fenix/web-runtime/hooks/use-admin-key-gate`）把关（见 §6.3）。
- 路由壳内的重定向一律用 `beforeLoad` + `throw redirect`。

### 2.4 导航
- 只用 `useNavigate()` 与 `<Link to>`：`void navigate({ to, params, search })`。
- **禁止** `window.location.href` / `replace` / `reload` 与 `window.history.pushState`；`window.location` 只允许**读取**（`pathname` / `search` / `host` / `protocol` / `origin`，现有合规用途是拼 WebSocket URL 与分享链接）。

### 2.5 懒加载与路由壳
路由壳只做懒加载与边界，页面实现放 owner 包。

- 每个 `lazy` 壳**必须自带 `Suspense`**：否则挂起会冒泡到 `_panel.tsx` 为自身代码块准备的**整屏** fallback，侧栏与聊天保活被卸载重建（用户看到「进这个页面整页刷新一次」）。页面内的 `loading` 只覆盖取数，接不住代码块加载。
- **加载提示只有 `Spinner` 一种写法**（`@fenix/ui-components/ui/spinner`，属 §4.1 的 `ui/*` 基础原语）：**不要手写圆环类名**，也不要用 `className` 复刻容器形态。
  - `variant`：`panel`（撑满父级剩余空间，路由 fallback / `_panel/*` 内容区）· `screen`（整屏等待）· `inline`（默认，外边距由调用方 `className` 给）。
  - `size`：`xs` 14px · `sm` 24px · `md` 32px（默认）· `lg` 40px——不要另写 `size-*` / `h-* w-*`。
  - `label` 三选一，决定读屏行为：有可见文案→传 `label`（自带 `role="status"`，不要再包 `<p role="status">`）；只有读屏文案→`label={<span className="sr-only">…</span>}`；纯装饰→不传（整块 `aria-hidden`）。落在填充色底上传 `className="text-current"`。
- 壳的接线形态只有两种：标准（单懒组件 + `Suspense`）与**组合根端口注入**（如 `_panel/organizations.tsx` 把 machine 的 `registryApi` 作为端口传给页面）——跨包装配是壳的职责。
- **壳可以有接线（tab 状态、创建回调、端口注入），但不做取数**；数据获取必须在页面或域模块内完成。
- **禁止**相对路径穿透到包内文件（`import("../../../pages/...")`），一律经包 `exports`。

### 2.6 侧栏装配
导航项由各资源包声明（契约 `WebNavigationItem` 在 `@fenix/web-runtime/shell/contribution`），Shell 只做装配与渲染。字段：`id`（唯一标识，**同时是路由目标**，Shell 拼成 `/agent/<id>`，也是 `hiddenTabs` 的裁剪键）· `groupId`（分组）· `order`（组内排序键，**必须唯一**，约定 10 步长递增）· `labelKey` + `ns`（文案，owner 是贡献方本包）· `icon`（`LucideIcon`，随项贡献）。

装配链：`deploy/assembly/ce.json` 的 `web` 列表 → `generate:web-contributions` → `apps/generated/web-contributions.ts` → `shell-navigation.ts` 的 `assembleNavGroups()` → `use-shell-navigation.ts`（翻译 + 按 `hiddenTabs` 裁剪）→ `ShellNavigation.tsx` → `AgentSidebar.tsx`。

- **分组与组间顺序归 Shell**（`SHELL_NAV_GROUPS`），资源包只声明自己属于哪组、组内排第几；未知 `groupId` 与同组 `order` 重复**装配期直接抛错**（加分组必须同改 `SHELL_NAV_GROUPS` 与宿主 `sidebar` 字典的 `navGroup*`）。
- **`hiddenTabs`** 来自 `GET /web/sidebar-config`（服务端值源 `APP_HIDDEN_SIDEBAR_TABS`，逗号分隔、不校验 id）：前端**只删项**，不改序不改分组；取不到按「无隐藏项」处理。
- **`activeNav` 由 pathname 手算**（`DefaultAppShell.tsx`）：`/agent/home` 取 `home`、chat 路径取 `null`、其余取路径首段；页面不高亮先查这里。

**新增控制台页面五步**：① 页面落 `packages/<pkg>/web/pages/` 并从包根 `web/index.ts` 导出 → ② 包字典补 `nav.<id>`（`web/i18n/locales/{en,zh}/<ns>.json`）→ ③ 包内 `web/contribution.ts` 的 `navigation` 加一项 → ④ 建壳 `apps/web/src/routes/agent/_panel/<id>.tsx`（**文件名必须与 `id` 同名**，否则点进去 404；由 `shell-navigation-routes.test.ts` 按真实路由表断言）→ ⑤ `bun run generate:web-contributions` 后跑门禁。新增**新包**还要补 `fenix.module.ts` 的 `web.contribution` 说明符、`package.json` 的 `./web` 三个出口、`deploy/assembly/ce.json` 的 `web` 数组，再 `generate:module-registry` 与登记 i18n（见 §9.2）。

### 2.7 现状偏离
- `/admin` 有第二张硬编码导航表（`routes/admin.tsx` 的 `NAV_ITEMS`，5 项），完全绕过 contribution 装配 — **已裁定保留为平行装配**，新增 `/admin` 页面照现有形态加项。
- 三个页面有路由但无导航项（`_panel/dashboard.tsx`、`channels.tsx`、`views.tsx`），只能输 URL 到达（owner 包不在装配 profile：channel / prod-view 无 `web/contribution.ts`）— 为其建 contribution 并进 profile，或产品裁定删页。
- 按钮 / 行内的**图标转圈**（`Loader2` / `LoaderCircle` / `Loader` + `animate-spin`，约 25 处）与 `Spinner` 是否合并尚未裁定；当前口径：按钮内联优先 `Spinner size="xs"`（填充底传 `text-current`），沿用图标转圈时不在 `Button` 内写 `h-* w-*` — 两种形态裁定合并后移除。

## 3. 状态管理
**React Context + `useState` / `useCallback`**，不引入 Zustand / Jotai / Redux / TanStack Query（当前零依赖，`bun.lock` 里出现的同类包均为传递依赖）。数据获取统一走 ahooks `useRequest`（见 §3.4）。

### 3.1 Provider 装配
装配在 `apps/web/src/routes/__root.tsx`，**是四分支条件树，不是一条线形链**：

- 会话加载中 → `<ThemeProvider>` + spinner
- 疑似未登录、非 `/login` 非 `/admin` → `<ThemeProvider>` + spinner（会话复核中，见 §2.3；复核为空后由守卫 effect 跳 `/login`）
- 未登录、`/login` 或 `/admin` → `<ThemeProvider><Outlet /></ThemeProvider>`——**无 OrgProvider、无 Toaster**
- 已登录 → `<ThemeProvider><OrgProvider><Outlet /><Toaster richColors closeButton position="top-right" /></OrgProvider></ThemeProvider>`

两个后果必须记住：**在 `/login` 与 `/admin` 下调用 `useOrgSession()` 会抛错**；这两条路径上 `toast` 无处落地。

i18n（`initReactI18next` 单例）与主题（`@fenix/ui-components/lib/theme`）**不是 Provider，不要给它们补 Provider**。

### 3.2 主题（全局强制亮色）
**本程序只有亮色一种外观**：不读 `localStorage`、不监听 `prefers-color-scheme`、无任何切换入口；系统 / 浏览器处于深色偏好时同样渲染亮色。

- 实现只有一份：`packages/ui-components/web/lib/theme.tsx`（导出 `ThemeProvider` / `useTheme()`，`useTheme` 在 Provider 外抛错不静默回落），**不要在任何调用点补第二份**。
- Provider **不再有参数**；职责是给需要布尔判定的消费方（canvas / SVG 渲染器）提供恒为 `"light"` 的 `resolvedTheme`，并在挂载时清掉 `documentElement` 上残留的 `dark` 类。
- 深色要生效需同时满足三件事，而**第一件当前没有任何生产者**：① 有代码给 `<html>` 或祖先加 `.dark`（全仓无）→ ② `index.css` 的 `.dark` token 块生效 → ③ `color-scheme` 固定为 `light`，由 `index.html` 的 `<meta name="color-scheme" content="light">` 与 `index.css` 的 `:root { color-scheme: light }` 共同保证（前者兜样式表生效之前的窗口，缺了会首屏闪深色）。

### 3.3 组织与会话上下文
**契约与实现分离**：契约在 `@fenix/web-runtime/contexts/org-session`，只声明 `organizationId` / `userId` / `isOwner` / `pending`（全字段可空可假，**消费方必须自己处理未就绪态**）；实现是身份包的 `OrgProvider`（`@fenix/identity/web`）——取数、切换与请求头注入属身份域。契约放中性的 `web-runtime`，是因为依赖矩阵禁止 `resources` 依赖具体平台实现。

- **`OrgSessionContext` 只能有一个 `createContext` 站点**：出现第二份会让资源包永远读到 `null`，而现象只是「权限判定全体失效」，很难反推。Context 必须用守卫 hook 消灭 `undefined` 判断，且**不静默回落默认值**（Provider 外抛错）。
- **组织身份只有两种合法读法**：资源包只能用 `useOrgSession()`（契约投影的 4 个字段）；`useOrg()`（身份包富上下文）仅限宿主 shell 与身份包自身。
- **禁止绕过上下文读取组织身份**（`localStorage.getItem("active_org_id")`），也禁止自行拼 `?active_org_id=`——这类写法会制造「UI 显示 A、请求操作 B」的 split-brain。
- **唯一例外是拿不到上下文的三处非 React 执行点**（身份包的 fetch 拦截器、两条实时通道的 URL 拼装：`agent-runtime/web/yjs/yjs-ws.ts` 与宿主 `api/file-events.ts`），统一经 `@fenix/web-runtime/lib/active-org` 的 `readActiveOrgId()` 取值。该模块是**全仓唯一读该键的地方**；代价是读到「最近一次本地写入」，HTTP 域模块与组件**不得**调用它（移除条件见 §3.6）。
- **请求头注入由身份域持有**：`OrgContext.tsx` 通过 `installFetchInterceptor()` monkey-patch `window.fetch`，现场注入 `X-Active-Org-Id`；域模块**不得**自己读组织 id 拼 URL 或头。
- **切换组织的唯一入口**是身份包 `OrgContext.tsx` 的 `switchOrg`（宿主 `AgentSidebar` 只是调用方）：快照当前值 → 乐观更新 state → 写 `localStorage` → `await orgApi.setActive()` → `navigate({ to: "/agent/home", replace: true })`；失败回滚 `localStorage` 与 state 并 `toast.error`。

### 3.4 数据获取
统一用 ahooks **`useRequest`**；禁止手写 `useCallback` + `useEffect` + `setState` 组合管理数据获取。当前全仓 `from "ahooks"` 只导入 `useRequest` 一个 hook。

```tsx
const { data, loading, error, refresh } = useRequest(() => unwrap(taskV2Api.list()));   // 查询
const { run: createTask } = useRequest(async (b: TaskV2CreateBody) => unwrap(taskV2Api.create(b)),
  { manual: true, onSuccess: refresh, onError: (e) => toast.error(e.message) });        // 变更
```

- **必须 `unwrap()` 或显式判断 `success`**：域模块返回 `ApiResponse`，`request()` 对 HTTP / 业务失败**返回 `{ success: false }` 而不 throw**，而 `useRequest` 的 `error` / `onError` 只理解 rejected Promise——直接 `await` 会把 4xx/5xx 当成成功（详见 §5.2）。
- 真实用到的配置项：`refreshDeps`（依赖变化重查）· `ready`（条件请求）· `manual`（mutation / 手动触发）· `pollingInterval`（轮询）· `loadingDelay`（抑制骨架闪烁）· `onSuccess` / `onError`。`cacheKey` / `cancel()` / `cache.mutate` / `debounceWait` / `retryCount` **当前没有任何使用范例**，需要时先确认 ahooks 行为并在 review 里说明，不要凭想象它的语义。
- **租户作用域轮询必须把组织 id 纳入 `refreshDeps` 并配 `ready`**（样板 `packages/resources/agent-config/web/hooks/use-agent-sidebar-tree.ts` 的 `{ pollingInterval: 15_000, refreshDeps: [orgId], ready: !!orgId }`）；不要用共享的 `intervalRef` 手写 `setInterval` 跨资源复用轮询。
- **跨组件刷新**用 `@fenix/web-runtime/lib/config-events` 的事件总线（`dispatchConfigChange` / `useConfigChangeListener`）——当前主力机制。
- **取消**：需要主动取消时用 `request()` 的 `signal` 选项传 `AbortSignal`；**不要依赖 `useRequest` 替你取消**（并发语义随版本变化），长轮询与「后发请求覆盖先发结果」的场景必须显式持有信号并在 cleanup 里 abort。
- **三态**：`loading` → `Skeleton`；`error` → `EmptyState`（`role="alert"` + 重试）；无数据 → `EmptyState`。**失败不得映射成 empty 或成功**——这是最容易通过 review 的静默缺陷。

### 3.5 Hooks 约定
- **落点跟随归属**：宿主 `apps/web/src/hooks/` 只放无域归属的 hook（当前为空；原先唯一的 `use-open-workflow-editor` 随自研工作流前端下线一并删除）；有明确归属的放它服务的目录旁（`shell/`、`pages/agent-panel/`（含其 `artifacts/` 子目录）），包内放 `<pkg>/web/hooks/`。
- **命名**：文件名 kebab-case 的 `use-<domain>-<noun>.ts`，导出 camelCase。
- **三层分工**：纯模型（`*-model.ts`，纯函数）↔ 编排 hook（数据与副作用）↔ 渲染组件。样板是侧栏智能体树的三件套：`@fenix/ui-components/web/agent-tree/agent-tree-model.ts`（纯派生）+ `agent-tree.tsx`（纯渲染）↔ `@fenix/agent-config/web/hooks/use-agent-sidebar-tree.ts`（取数与领域操作）+ `components/agent-panel/agent-sidebar-tree.tsx`（领域对象 → 视图模型、弹窗装配）；拆页面优先按这三层切，而不是按行数切。
- 事件订阅类 hook 用 `useRef` 持有稳定回调，避免 `useEffect` 反复订阅 / 取消。
- **表单用 react-hook-form + zod**（命名 `formSchema` / `FormValues` / `form`），不手写 `useState` 管表单状态。
- **Chat 状态 hook 有归属**：`useChatState` / `useSessionState` 在 `packages/agent-runtime/web/hooks/`；`useChatPageVisible` 与 `ChatPageVisibleContext` 在 `packages/web-runtime/web/hooks/use-page-visible.ts`（该文件**没有** `usePageVisible` 导出）。宿主不要在 `src/hooks/` 复制包内实现。

### 3.6 现状偏离
- **仍保留手写取数的位置**（§3.4 禁止的组合）：
  - `sandbox/web/src/pages/admin/components/RemoteSandboxPanel.tsx:55` 的 `loadSandboxes`（失败态兼「上屏原始 `ApiError.message`」与「`unauthorized` 判定后回调 `onAuthFailure`」）— 错误文案口径单独裁定并落地后移除。
  - `platform/identity/web/contexts/OrgContext.tsx:68` 的 `refreshOrgs` — 组织切换改成原子转换（见下条）后移除；「失败只 `console.error`」另见 §5.9。
- **组织切换不是原子转换**：`localStorage` 先于服务端确认写入（§3.3），失败回滚已实现，存在「本地快照已变、服务端未确认」的窗口。
- **「失败落到空态」仍未收口的位置**（8 处已修）：
  - `model-management/web/lib/model-gateway-query.ts` 手动查询（失败分支**有意**顶掉上一轮结果，`error` 优先于 `hasData`，与列表口径 `error && itemCount === 0` 分叉）— 两个 Tab 改成自动轮询时改回 `error && !hasData`。
  - `agent-config/.../AgentHomePage.tsx:55` 模板 pills — 给 `agent-home-template-pills.tsx` 加失败态与重试后移除。
  - `sandbox/.../use-sandbox-dashboard.ts` 组织下拉与 `model-management/.../use-model-gateway-dashboard.ts` 主体下拉（同一处 `SearchableUsageFilter` 缺口）— `OrganizationSelect.tsx` 接受错误端口后移除（影响资源池表单与用量页筛选项两处）。
  - `identity/.../AgentOrganizationsPage.tsx:94,:175` 机器列表与成员候选 — 把状态透进 `OrganizationsWorkspace` 的 props 后移除。
  - `task/.../AgentTasksPage.tsx:66,:89` 任务列表与 Agent 下拉 — 补持久失败块（需改各面板 props）后移除。
  - `knowledge/.../RetrievalTestPanel.tsx` rerank 候选下拉 — 给该下拉（或共享 `Select` 包装）开错误端口后移除。

## 4. 组件规范
### 4.1 组件归属
**已有组件禁止重复开发**，`packages/ui-components` 是唯一来源：基础原语 `@fenix/ui-components/ui/<name>`（含 `chat/**` 聊天基元，均逐文件子路径）· 通用业务组件 `config/<name>` · 无渲染工具 `lib/<name>` · 其余共享件 `components/<name>`。**按需深链优先**（根 barrel 适合一次取多个组件）。新增 / 删除组件必须同批改 `web/index.ts` 与 `package.json` 的 `exports`——两者不一致会造成「深链可用、整包导入不可用」，由 `web/__tests__/barrel-exports.test.ts` 的显式名单守护。

**归属由消费者集合决定**：出现第二个包消费就下沉到 `ui-components`，不要在各消费方各留一份；只有一个消费者时留在原处，不做推测性抽象。

`config/` 下 9 个组件（props 以包内类型为准）：`FormDialog` 通用表单对话框 · `ConfirmDialog` 危险操作确认（`title` / `description` 必填）· `EmptyState` 内联状态块 · `StatusBadge` 状态徽标 · `ScopeFilterBar` 配置型目录页的「搜索框 + 作用域过滤条」（**不接 i18n**，文案全经 props 传入；也不认识业务作用域）· `DataTable` TanStack Table 封装 · `BatchActionBar` 批量操作条 · `AdminKeyGate` 系统 Master Key 输入门（纯展示受控，不取数、不 import `web-runtime`，状态机在 `@fenix/web-runtime/hooks/use-admin-key-gate`）· `LabeledField` 表单字段名与控件的关联包装。

三条跨组件契约：

- `StatusBadge` / `EmptyState` **只收语义（色调）不收色值**：业务状态词表经 `toneMap` 注入，配色（含 dark 变体）留在包内；包外判定色调用 `getStatusTone(status, toneMap)`，不要复刻配色类。
- `EmptyState` 的 `tone` 默认 `neutral`（确实没有数据、筛选后无匹配），`danger` 用于读取失败、无权限；持久错误再补 `role="alert"`。它**不自带 Card 外壳**（容器与边距由调用方给），图标不传尺寸类时沿用 lucide 默认 24px，颜色一律不要手写。
- **空态 / 失败 / 无权限刻意共用一个骨架**：不要新建第二个「空态组件」或「加载失败组件」。判据：**无权限不给重试**（401/403 重试只会重复被拒），**失败给重试**。

**已下沉到 `ui-components` 的共享原语**：`ui/status-dot` · `ui/spinner`（§2.5）· `components/ClosableTabPill` · `components/agent-catalog-index`（主从面板左侧目录栏的共享构件集，技能库 / MCP / 模型库 / 知识库 / 组织管理五页共用——**改目录样式只改共享 CSS 与组件，不要在页面里长第二份**，页面只保留独有语义）· `lib/clipboard` / `lib/format` · `chat/view/PublicErrorCard` / `chat/panels/chat-interaction-region` / `chat/timeline/tool-json-block`。主从壳 `components/agent-master-detail-workspace` 早于去重批次入库，有六个消费者，**不在上列**。

### 4.2 Dialog 状态管理
三个关联 `useState` 控制新增 / 编辑 / 删除：`dialogOpen` + `editingItem`（`null` = 创建）、`confirmOpen` + `deleteTarget`。

- **创建**：清空编辑状态 → `setDialogOpen(true)`；**编辑**：填充表单 → `setDialogOpen(true)`。
- **`onOpenChange`** 回调中清理状态：`if (!open) resetState()`。

### 4.3 表单提交
用 **react-hook-form + zod**（`zod/v4`）配合 `FormDialog`，禁止手动 `useState` + 手写校验。

- **`FormDialog` 在内部创建 `useForm`**，页面不持有 form 实例：schema 与提交函数经 `formConfig` 传入，子组件用 `useFormContext()` 绑定字段。
- **重置表单靠 `key`**（如 `key={`${editingItem?.id ?? "create"}-${formResetKey}`}`，key 变 = 强制重挂载、重置内部 `useForm`），不要在 `onOpenChange` 里手工 `reset()`。
- `schema` / `defaultValues` / `onFormSubmit` 三者要同时在 `formConfig` 里给出；`onFormSubmit` 入参是 `Record<string, unknown>`，调用方按域类型收窄后再用（不在包内引入域类型）。
- **`onSubmit` 与 `formConfig` 互斥**：传了 `formConfig` 时 `onSubmit` 被忽略；只用 `onSubmit` 时它只做 `preventDefault` + 回调、**不做校验**——无校验需求才用它。

### 4.4 组件声明与类型
- **业务页面与业务组件统一用 `function` 声明**（`export function AgentSkillsPage() {...}`）；**例外只针对 `chat/primitives/*`**（沿用上游箭头函数写法），不要扩散到业务代码。
- props 类型用顶部 `interface` 或内联类型，不要匿名对象字面量散落多处。
- **禁止 `as any`**：手写生产代码只剩 `lib/clipboard-polyfill.ts`、`lib/random-uuid-polyfill.ts` 两处（浏览器 API 垫片）与 `FormDialog.tsx` 一处带 `biome-ignore` + 原因的行级例外；生成产物与测试另有豁免口径（§4.7）。第三方类型缺陷用最小范围收窄。
- **`React.memo` 的 comparator 必须与调用方 prop 稳定性一致**：`ChatView` / `EntryRenderer` / `MessageResponse` 有显式 comparator，改它们的 props 时同步更新 comparator 与渲染测试，否则会出「消息不更新」或「整表重渲染」（§8.5）。

### 4.5 类型定义

| 场景 | 位置 |
|------|------|
| 只在该页面使用 | 页面文件内联（组件函数上方） |
| 资源域类型 | owner 包的 `web/api/<domain>.ts`，经包 `exports` 按消费点导出 |
| 跨资源包共享的域类型 | `@fenix/web-runtime/types/config`（`AgentInfo` / `ProviderInfo` / `SkillInfo` / `ModelEntry` 等，6 个资源包共用） |
| 只服务宿主页面、无资源包归属 | `apps/web/src/types/` |

- **边界转换**：协议 DTO、领域对象与视图模型在边界处独立转换，不做跨层共享可变结构；前端类型必须对应后端真实返回，**禁止声明后端不存在的「幻影字段」**。
- 域内类型跟随域模块，只有当**第二个包**也需要时才上提到 `types/config`——上提后即跨包契约，改动要同步搜全部消费方。
- 契约漂移没有编译期保护：`request<T>()` 的泛型是断言而非校验，改后端响应必须同批改前端类型。

### 4.6 文件结构
import 顺序由 Biome 的 import-sort 统一（`precheck` 会跑），形态是**字母序分组**、包内相对导入放最后：① React / 框架 → ② 路由（`@tanstack/react-router`）→ ③ 第三方库（含 `@fenix/ui-components/ui/*` 基础 UI）→ ④ 跨包能力（经各包 `exports`，不用别名）→ ⑤ 本包 / 本目录相对导入 → ⑥ 类型（`import type`）。人工组织按此语义分组即可，不要手工排序。

### 4.7 文件规模与模块拆分
- **单个文件不得超过 500 行**（生成产物豁免）。接近上限时应重构模块边界，而不是继续追加。
- 拆分按**职责**切、不按行数切：「页面 + 数据编排 + 传输适配」挤在一个文件里是超限的常见成因；样本见 `packages/resources/task/web/pages/agent-panel/`（壳 / 页面 / 列与动作登记 / 运行态看板 / 纯工具 / `components/`）。
- 收益判据是**耦合而非行数**：拆出的模块若仍需反向读取原文件内部状态，说明缝切错了——先抽状态归属，再拆渲染。
- 上传 / 预览 / 文件树等重型交互按 §3.5 的三层拆分。

### 4.8 现状偏离
- **超 500 行的前端生产文件已清零**（2026-09-23 实测：超限 0 个，最大 496 = `mcp/web/pages/agent-panel/pages/agent-mcp-dialog.tsx`；400–499 区间另有 30 个；口径 `apps/web/src` + `packages/**/web/**`，排除测试、生成文件与服务端路径，行数取文件总行数，复算 `(find apps/web/src -name '*.ts' -o -name '*.tsx' | grep -v __tests__ | grep -v routeTree.gen; find packages -path '*/web/*' \( -name '*.ts' -o -name '*.tsx' \) | grep -v __tests__ | grep -v '/src/server/' | grep -v '/src/routes/web/') | xargs wc -l | awk '$1>500'`）— 新增模块仍靠 review 对照（§11.3）。
- **§4.2 / §4.3 的「Dialog 关闭清理状态 / 表单重置走 `key` / 不手写 `useState` 校验」仍有 8 处未收口**（其余命中已修，改完即合规）：
  - `identity/web/components/ChangePasswordDialog.tsx:63,80-87`——一个 `error` 兼两条手写校验与服务端 `submitError.message` 回显 — 拆出可脱离弹窗渲染的字段体、补回归网兜后换 `FormDialog`。
  - `observer/.../AdminPeoplePage.tsx:162-169`——`UserActionDialog` 的 `submit` 是**静默 no-op**（`disabled` 判据与它逐字重复两遍）— 先给 `FormDialog` 定「提交中是否允许关闭」的 props 口径，再与下一条一起收。
  - `prod-view/web/components/prod-view-editor.tsx:152`——同形静默 no-op（字段靠「打开时重置」覆盖，可见行为正确，属**潜在**风险）— 与上一条同批收。
  - `knowledge/.../ChunkDetailSheet.tsx:78-86`——`useEffect([open, fetchChunks])` 手写四条 `set*`（依赖含 `fetchChunks`，`open` 为真时会再跑一次、**静默清掉用户当前的翻页与搜索词**）— 把「Sheet 打开」与「数据源变化」分开（如 `open` 交给外层做 `key`）后收。
  - `sandbox/.../PoolDialog.tsx:50-58`——`useEffect([open, pool])` 手写五条 `set*`（依赖稳定、无可见缺陷）— 统一口径时一并换成 `key`。
  - `agent-config/.../agent-editor/agent-editor-body.tsx:118-129`——`form.reset()` 与关闭清理写在 effect 里，`useForm` 由页面自己持有 — 单独一轮把 `key` 落到整个编辑器弹窗。
  - `identity/.../AgentApiKeysPage.tsx:248-251`——`onOpenChange` 只清 `newKeyValue`，三个表单字段靠 `openCreate` 重置，与 `AdminPeoplePage` 同形 — 同批收。
  - `knowledge/.../knowledge-base-form-dialog.tsx:64`——`onOpenChange` 原样透传，字段是 props 受控（`catalog` 上），属「表单状态不在弹窗内部」的另一种形态。
- **`DataTable` / `BatchActionBar` 生产零消费（保留，不按死代码删除）**：对外 `config/` 契约（已进 `exports`，由 `barrel-exports.test.ts` 钉住），demo 里是活的 — 确认外部（EE 或下游宿主）不再需要时，连同 demo 段落、包内用例与 `exports` 键一次删净。
- **本地重复实现**：包内同名同形态已无残留（最后一处 `workflow` 的 `CollapsibleGroup` 随该包 web 面于 2026-09-29 下线删除）；**跨包**重复仍无门禁 — 按「第二个包开始消费就该下沉」（§4.1）靠 review 收口。
- **`task` 包的域类型未从包出口导出**：`TaskV2Info` 权威定义在服务端 zod schema，web 侧用相对路径 `from "../../../api/tasks-v2"` 取，与 §4.5 不一致 — 经包 `exports` 导出后移除（新增类型不要照抄这种取法）。
- **刻意分叉（已裁定，不要以「去重」为由重开）**：`memory/hindsight` 两套图谱（Cytoscape 与自绘 canvas，只共用 `graph-model.ts` 的数据契约）· `sandbox` 的 `RowDeleteButton`（`size="sm"` + `variant="outline"` + 红描边类串全仓只有本包在用）· 形态未定型且第二个真实用例仍在本包内的共享件不上移（如 sandbox 的 `JsonPreview`）— 与「归属由消费者集合决定」同一条口径，不是遗漏。
- **同名但契约不同，核实不是重复实现**：`sandbox/.../InstanceRow.tsx` 与 `knowledge/.../embedding-model-rows.tsx` 的 `InstanceRow`。

## 5. API 建模层
### 5.1 分层与归属
- **请求基建** `packages/web-runtime/web/api/request.ts`（credentials、序列化、超时、合并外部信号、错误标准化）→ `@fenix/web-runtime/api/request`；**域模块** `packages/<group>/<pkg>/web/api/<domain>.ts`（URL 拼装、请求/响应序列化、域内类型）→ `@fenix/<pkg>/web`；**宿主专有域** `apps/web/src/api/<domain>.ts`（只服务宿主、无资源包归属）→ `@/src/api/<domain>`。
- **归属判据**：接口对应哪张表、哪个 owner，域模块就放在那个包（见 §1）；默认经包根 `./web` 出口，跨包窄口须在该包 `exports` 显式声明且导出文件必须是浏览器安全入口（现为 `@fenix/agent-runtime/web/api/environments` 与 `@fenix/agent-runtime/web/api/instances`）。
- **请求基建不做组织头注入**：租户身份靠 `credentials: "include"` 携带的 better-auth 会话 cookie，以及身份包 fetch 拦截器注入的 `X-Active-Org-Id`（见 §3.3），域模块不得自己拼组织参数；**组件**只调用域模块 → 处理结果 → 更新 UI，不写 `fetch`、不拼后端 URL。

### 5.2 共享请求基建契约
#### 导出面
- `request<T>(url, options)` → `Promise<ApiResponse<T>>`；`unwrap<T>(resp)` 成功返回 `data`、失败抛 `ApiError`；`ApiError` 字段为 **`message` / `code` / `data`**（本节只描述契约、不复制实现，实现见 `packages/web-runtime/web/api/request.ts`）。
- `ApiResponse<T>` = `{ success, data?, error?: { code, message, data? } }`；`PaginatedResponse<T>` = `{ items, total, page?, pageSize? }`（`page` / `pageSize` 可选，并非所有分页端点都返回）；`ErrorCode` = `KnownErrorCode | (string & {})`，兼容后端透传的自定义业务错误码；`WRITE_TIMEOUT_MS` / `UPLOAD_TIMEOUT_MS` 均 120s，与后端 file_op / upload 对齐。
- `RequestOptions` 与 `NetworkError` **不是导出符号**：调用方无法对 request 层做类型标注，也无法用 `instanceof` 区分网络类错误，只能判 `error.code === "NETWORK_ERROR"`；`ApiError` **没有 `status` 字段**，HTTP 状态码在这一层已丢失，需要按状态码分支时只能靠 `code`。

#### `RequestOptions` 字段
- `params` 路径参数 `:id` 插值 · `query` 查询参数自动拼装 · `body` 普通对象走 JSON、`FormData` / `Blob` 直传 · `timeout` 超时 ms（默认 30000）· `signal` 外部取消信号，与内部超时信号合并。
- `opId` 文件写操作幂等 ID，透传 `x-file-op-id`（`docs/arch/12-files.md` §7.2）：`request()` **不自动重试**（重试是调用方策略），调用方重发同一动作须复用同一 opId；`@fenix/resource-machine` 的 `web/api/fs.ts` 目前每次调用新生成，见 §5.9。
- `bearerToken` 注入 `Authorization: Bearer`（如系统 Master Key，`docs/arch/21` §5），属内部头，调用方 `headers` 覆盖不了，要换凭证就换本字段 · `headers` 请求头透传（如 `If-None-Match`），只补内部未设置的头 · **同名冲突时内部值胜出**——`content-type` / `x-file-op-id` / `authorization` 由 `request()` 自己写入，判定用 `Headers.has`（大小写不敏感），三条行为有用例钉住（`packages/web-runtime/web/__tests__/request.test.ts`）· 组织头 `X-Active-Org-Id` **不在清单**：它由身份包 fetch 拦截器在调用方未提供时补值（§3.3），域模块仍不得自己拼组织头或组织参数。

#### 失败语义
- `request()` 对 HTTP 失败（4xx/5xx）与业务失败（`success === false`）**返回 `{ success: false, error }`，不 throw**；`unwrap()` 负责把失败转成 `throw ApiError`。
- **直接 `await request()` 并依赖 `catch` / `onError` 的代码会把 4xx/5xx 当成成功**——`useRequest` 的 `error` / `onError` 只理解 rejected Promise；**强制要求**：调用方必须 `unwrap()` 或显式判断 `success` 后再使用数据，不得省略解包，不得新增依赖 `catch` 的调用点。

#### 其它约定
- **超时下限**：写操作超时不得短于后端（file_op 60s / upload 120s），需要区分时用 `WRITE_TIMEOUT_MS` / `UPLOAD_TIMEOUT_MS`；`timeout` 从发起请求算到响应体读完，慢 `json()` / `text()` 同样会被掐断；超时与外部取消都归 `NETWORK_ERROR`，文案分别为「请求超时」与「请求超时或已取消」（后者不可重试的语义由调用方判 `error.code`）。
- **外部 `signal` 不留监听残留**：合并到调用方 `signal` 上的监听器在请求结束（成功 / 失败 / 取消）后即摘除，可长期复用同一个 signal · **错误码归一化**：后端 snake_case（`not_found` / `validation_error` / `remote_error`）与部分模块直接透传的 `ErrorCode` 常量统一归一化，未提供时按 HTTP status 兜底映射（401/403 → `UNAUTHORIZED`、404 → `NOT_FOUND`、422 → `VALIDATION_ERROR`、≥500 → `SERVER_ERROR`）。
- **记录失败但不弹 UI**：`request()` 用 `console.error` 记录失败、**不调 `toast`**——UI 反馈是组件职责（见 §5.8）。

### 5.3 非标准响应与非 REST 传输
- **每个例外点都必须登记在下面这张表里**，两类性质不同、不要混用：**能力缺口**＝`request()` 实现缺失（blob / 流 / 进度 / 响应头 / 304），修法是**给 `request()` 补能力**而不是在调用点继续手写，补完后这些点整体退回 `request()` + `unwrap()`；**协议例外**＝传输面本身不经 `request()`（WebSocket / SSE / 第三方客户端库），补能力后也不应改写。
- 无业务载荷的成功响应（knowledge `knowledge-models.ts` `{ ok: true }`、prod-view `prod-views.ts` `{ ok: boolean }`）→ `request<{ ok: boolean }>()` 原样返回，不套 `data` 信封；业务体自带判别字段（model-management `providers.ts` `ModelTestResult{ok, content}`）→ 原样保留 · 协议例外
- 裸响应体（无 `data` 字段）：identity `web/lib/password-crypto.ts` 取登录加密公钥、identity `web/pages/login/login-transport.ts` 取 `{ signupAllowed }` → `request<T>()` 后显式判 `success` 再取值 · 协议例外
- 二进制 / 文本 / PDF 读与二进制下载（Blob）：knowledge `web/api/knowledge-bases.ts` 三处 `fetchResourceFileText` / `fetchResourceFileBinary` / `isResourcePdfPreviewAvailable`（第三处是**探测**语义：非 2xx 是正常分支，返回布尔而不抛错）、machine `web/api/fs.ts`（文件 / ZIP）、skill `web/api/skills.ts`（`download`）→ 裸 `fetch` / `XHR` + 域内 `buildResourceReadError()` / `buildDownloadError()`，成功收成 `Blob`、失败归一为 `ApiError`（code 与 `unwrap()` 同源），不让组件看到原始 `Response` · 能力缺口
- 文本流下载与 Bearer 流式读：observer `web/api/system-logs.ts`（`systemLogsApi.download`，成功只回 `Blob`，建锚点与 `revokeObjectURL` 归调用方）、sandbox `web/src/api/system-sandbox.ts`（toml / 诊断文本 / 命令 SSE，`buildStreamError()` 归一，`executeCommand` 返回原始 `Response` 由调用方消费流；三处只带 `Authorization: Bearer`——`/api/system/*` 守卫只读该头，`apps/server/src/plugins/system-api-auth.ts`，不送 cookie）· 能力缺口
- 上传进度（machine `web/api/fs.ts` 的 `uploadFiles`）→ `XMLHttpRequest`，进度 / 超时 / abort / `x-file-op-id` / 错误归一全自建 · 能力缺口
- 条件请求与预览源读取（machine `web/api/fs.ts`）：`revalidateWorkspaceTree` 裸 `fetch` 走 `If-None-Match` → 304 并读回 `ETag`，返回判别式结果而非抛错（304 不是失败）；`readPreviewSource` + `buildPreviewSourceUrl` 裸 `fetch` + **返回原始 `Response` 由调用方消费**（与 sandbox `executeCommand` 同一形态），预览 URL 也归本模块拼（`.../fs/<path>?preview=true`），宿主经 `PreviewTab` / `FileViewerPreview` 的 `fetchPreview` / `buildPreviewUrl` 注入，包内不再自带宿主路由、也不留全局 `fetch` 兜底 · 能力缺口
- WebSocket `/acp/yjs/*`（§8）与 `/web/file-events`（文件树事件）：`@fenix/resource-machine/web/api/file-events.ts` 的 `openFileEventsConnection`；两条通道均不走 `request()`，登记见 §8.1 · 协议例外
  （第三条协议例外——自研 workflow 前端的 SSE（`EventSource` + `withCredentials`、`?fromSeqNum=` 续传）——随该前端于 2026-09-29 整体删除（2F），前端已无 `EventSource` 调用点；服务端 `/web/workflow/:id/events` 仍在，出现新消费方时按本条重新登记。）
- better-auth 客户端：identity `web/lib/auth-client.ts`（`authClient.*`）及其 `/api/auth/sign-up/phone` → 传输由库内 `createFetch` 持有；库内核路由一律用客户端方法，自定义路由（无客户端方法）保留手写请求 · 协议例外
- 本地 blob / 预览源读取：`ui-components/web/chat/primitives/internal/prompt-input-file.ts` → 读的是本地 blob URL，**不是后端调用**，不属本节管辖 · 不适用
- **新增例外点**须在提交里写明：命中点、为何不能走 `request()`、失败归一函数、成功返回值形状、能力补齐后的回退动作。**不在登记范围的两类 `fetch`**：① 统一层实现本身（`web-runtime/web/api/request.ts` 的那一次 `fetch`，是上表 `request()` 行的底座，不是调用点）；② 本地 blob URL 读取（上一行）。全仓复扫口径见 §11.3 的「组件中裸调 `fetch()`」一行。

### 5.4 域模块标准模式
- 域模块从 `@fenix/web-runtime/api/request` 取 `request` 与类型，**返回 `ApiResponse` 交给消费方解包**；三点可复现的模式：**文件头注释说明域与例外** + **域内类型与模块同文件**（不散落到宿主）+ **单一具名对象导出、不在模块内做 UI 反馈**。
- **解包归属要一次性决定**：新增模块按上面的模式返回 `ApiResponse`，不要在域模块内提前解包；当前仓库存在两类历史写法（见 §5.9），混用会让调用方无法从签名判断拿到的是数据还是 Result——新增代码不要扩大这个面。

### 5.5 域模块命名与组织
- 文件名 **kebab-case**（与资源域一致：`knowledge-bases.ts`、`workflow-defs.ts`）· 导出对象 **camelCase + `Api` 后缀**，避免与类型名冲突（`taskV2Api`、`mcpApi`、`kbApi`）。
- 位置跟随 owner 包 `packages/<group>/<pkg>/web/api/`（`packages/resources/skill/web/api/skills.ts`），由包 `./web` 出口转出、导出面按包外真实消费点收敛（`export * from "./api/tasks-v2"`）；非 REST 传输与域模块同层、不塞进 `request()`（两条 WS 通道：`packages/agent-runtime/web/yjs/yjs-ws.ts` 与 `packages/resources/machine/web/api/file-events.ts`）；请求头在同一个文件里组装，鉴权头的选择属于域模块（`system-sandbox.ts` 的 `adminOptions()`）。

### 5.6 域模块一览
- `@fenix/web-runtime` `web/api/request.ts`（请求基建，非域模块）；`@fenix/agent-runtime` `environments.ts`（环境与实例；**窄口** `@fenix/agent-runtime/web/api/environments`）、`instances.ts`（实例生命周期；**窄口** `@fenix/agent-runtime/web/api/instances`）；`@fenix/identity` `api-keys.ts`、`organizations.ts`（API Key 与组织）；`@fenix/agent-config` `agents.ts`、`sites.ts`、`web/src/api/sidebar-config.ts`（Agent 配置、站点、侧栏配置）。
- `@fenix/model-management` `providers.ts`、`models.ts`、`model-gateway.ts`（Provider、模型、模型网关）；`@fenix/resource-skill` `skills.ts`（Skill 元数据与内容）；`@fenix/resource-mcp` `mcp.ts`（MCP server）；`@fenix/resource-knowledge` `knowledge-bases.ts`、`knowledge-models.ts`（知识库与嵌入模型）；`@fenix/resource-task` `tasks-v2.ts`（定时任务 v2）。
- `@fenix/resource-channel` `channels.ts`（IM 通道）；`@fenix/resource-machine` `registry.ts`、`fs.ts`（机器注册表、文件域客户端）；`@fenix/resource-memory` `hindsight.ts`（记忆）；`@fenix/resource-prod-view` `prod-views.ts`（生产视图）。
- `@fenix/resource-observer` `observer.ts`、`system-logs.ts`、`system-people-tree.ts`（观察面板与系统日志）；`@fenix/resource-sandbox` `web/src/api/{sandbox-pools,system-organizations,system-sandbox}.ts`（沙箱与系统组织）；宿主 `apps/web/src/api/` 只剩 `branding.ts`（宿主专有域，无资源包归属；`file-events.ts` 与 `fs.ts` 已归位 `@fenix/resource-machine`、`instances.ts` 归 `@fenix/agent-runtime`、`peri-task-details.ts` 归 `@fenix/model-management`、`helpers.ts` 已删除）。按 owner 归属维护，**不记录接口数量**（会漂）；新增域模块时同步本表，删除模块时同步删行。

### 5.7 组件中使用
- 组件**不直接 `await` 域模块**，统一交给 ahooks `useRequest`，并用 `unwrap()` 解包。
- 查询用 `useRequest(() => unwrap(taskV2Api.list({ page, pageSize })))` 自动管理 `loading` / `error` / `data`，组件挂载时自动执行；变更是 `manual: true` + 手动 `run`，`onSuccess` 里 `refresh()` 与 `toast.success(t("toast.saved"))`，`onError` 里 `console.error` 与 `toast.error(err.message)`。

### 5.8 禁止事项
- **禁止**在组件中直接写 `fetch` / `XMLHttpRequest`、在 `useEffect` 中裸调 `fetch`（能力缺口见 §5.3，须登记后由域模块承载）、拼装后端 URL（含 WebSocket URL，见 §8.1）；**禁止**在域模块中重复定义 `request()`（统一从 `@fenix/web-runtime/api/request` import）、在 API 模块内调用 `toast.error`（UI 层职责，错误由组件 `onError` 处理）。
- **禁止**新增 `/v1`、`/v2` 历史前缀（由 `frontend-no-legacy-api-prefix` 规则阻断，见 §11.2）；**禁止**绕过包 `exports` 深引 `@fenix/<pkg>/src/*`、`@fenix/<pkg>/web/src/*`；**禁止**直接 `await` 域模块并依赖 `catch`（必须解包，见 §5.2）；**禁止**把失败静默映射成 empty 或成功状态。
- **禁止**在用户可感知失败的位置只写 `console.error` 而不给用户可见反馈——判据是三条**同时**成立：① 位置在组件 / 页面 / hook 的 `catch` 或异步失败分支里；② 失败由用户操作触发，或使用户正在看的内容不可用；③ 同作用域（同一函数内）没有别的用户可见反馈（`toast` / 内联错误态 / 降级 UI）。这条规则**没有门禁，只能人工 review**；三类位置**必然豁免**：域模块与请求基建（模块内禁止 UI 反馈）、ErrorBoundary 的 `onError`（降级 UI 本身就是可见反馈，§7.1）、后台触发路径（轮询 / WS-SSE 回调 / 定时器 / 订阅）。
- 补反馈时用 `toast.error(t("<key>"))`，**保留原有 `console.error`**（它承载诊断上下文）；`packages/ui-components/**` 内部不直接调宿主 `toast`，只经 `onNotice` / `onError` 端口抛出文案；`/login` 与 `/admin` 下没有 `Toaster`（§3.1），这两条路径上的失败必须用内联错误态——那里 `toast.error` 是静默 no-op。

### 5.9 现状偏离
- `identity/web/contexts/OrgContext.tsx` 的 `refreshOrgs` 失败只 `console.error`（页面级失败块已由 `AgentOrganizationsPage` 自己的取数承担，§3.6）与 `agent-config/web/components/agent-panel/SiteFrame.tsx` 挂载二维码后台预生成失败只留 `console.error`（分享弹层停在永久 spinner）— 各自补上不依赖 toast 的持久失败态后移除
- 解包归属两代写法：9 个模块域内 `unwrap()`（machine `fs.ts` / 宿主 `peri-task-details.ts`、`model-gateway`、`observer`、`system-logs`、`system-people-tree`、`hindsight`、sandbox `system-organizations` / `system-sandbox`），另有 3 个 blob 家族模块（`knowledge-bases`、`skills`、`system-sandbox` 部分方法）域内抛错，去重后合计 11 个模块的对外签名是数据或抛错、不是 Result — 迁到 §5.4 的「新增返回 `ApiResponse`」后移除（新增代码不要扩大这个面）
- machine `web/api/fs.ts` 写操作每次调用新生成 `opId`（`randomUUID()`），重发同一动作服务端无法据此幂等去重，`request()` **不自动重试**（`docs/arch/12-files.md` §7.2）— opId 生成上移到「用户动作」层（或让域模块接受调用方传入 opId）后移除
- `frontend-no-legacy-api-prefix` 只识别裸 `request(...)`，成员调用 `this.request("/v1/...")` 或裸 `fetch("/v1/...")` 会绕过 — 当前控制台代码无 `/v1`、`/v2` 命中，但不要依赖这条规则做全量保证
- 失败提示回显服务端 `err.message` 只剩 5 处登记了理由的豁免（处数由 `apps/web/src/__tests__/package-error-text-echo.test.ts` 按括号配对钉住）：mcp `testUrl` 探测（2 处）、knowledge 厂商 Key 校验（1 处）、sandbox `feedback.message`（2 处）— 各自理由消失（诊断另有承载 / 文案改 `t()`）后收口。自研工作流前端下线时一并去掉的两条（`WorkflowEditor` dry-run 的 `issues[].message`、YAML 导入失败）无需再收口
- `knowledge/web/pages/agent-panel/pages/agent-knowledge-load-failure.tsx` **有意**展示服务端 message 作排障上下文，与 §9.3 口径冲突（涉 4 个调用点、5 条既有断言）— 单独裁定后移除；`model-management` 的 `loadProvidersError` / `loadModelConfigError` / `batchDeleteError` / `modelSubrow.testModel.error` 为全仓零引用死键 — 按「不删除无关死代码」登记于此，随所在代码清理时移除

## 6. 安全规范
前端安全是质量基线：以下规则**必须**遵守，违反需在 code review 中 block。

### 6.1 XSS 与不可信内容渲染
- **禁止** `dangerouslySetInnerHTML`，除非经 DOMPurify 清洗——清洗即合规，**不需要**额外的批准注释，但须在该行或函数上方写清**内容来源**（谁产生、为何可信）。
- **禁止**直接拼接 HTML 字符串注入 DOM；清洗放在**域模块内**，组件只接清洗后的值。
- 用户生成内容（UGC）与 **Agent / LLM 输出**同等对待：都是不可信输入。
- Markdown 以 `streamdown` 为**唯一渲染器**（`MessageResponse`，懒加载，经 `allowedTags` 白名单 + `urlTransform` 收口），新增场景复用该链路、不得另起；唯一例外是 `react-markdown` 只剩 knowledge 预览一处（`ResourcePreviewContent.tsx`，输入是用户上传的文件正文，已接 `rehype-sanitize` 的 GitHub 默认 schema，且不渲染原始 HTML）。

### 6.2 iframe 沙箱
- **Markdown / Agent 输出里的 `<iframe>`**：**必须**去掉 `allow-same-origin`（它与 `allow-scripts` 同开时 iframe 内脚本可读写父页面 DOM 与存储——**等价于没有沙箱**），且对 `src` 做协议与域名校验；现为 `ui-components` 的 `IframePreview` 两处 `sandbox="allow-scripts allow-popups"`，`src` 过协议白名单（`http:` / `https:` / 相对地址 / `data:`），模型自带的 `sandbox` 被剔除，并有包内用例。
- **用户自己的站点**（`siteUrl`、`SiteFrame`）：可保留 `allow-same-origin`，但**必须**带 `referrerPolicy`（现为 `no-referrer`：`SiteFrame.tsx`、`AgentSitesCard.tsx`）。
- **同源文件预览**（pdf / office 转 pdf）：可用 `srcDoc` 或同源 URL，`sandbox` 可选——现三处无 `sandbox`（同源，风险低）：knowledge 的 `ResourcePreviewContent.tsx` 两处、`ui-components/web/components/preview/native-pdf-plugin.ts`；**knowledge 的 HTML 预览不算这一类**：它是用户上传的 UGC，`srcDoc` + 固定 `sandbox="allow-scripts"`（不带 `allow-same-origin`：`srcdoc` 继承父页面源，与 `allow-scripts` 组合即可自行摘掉 sandbox）；工作区预览器的 `html-plugin.ts` 同为 UGC 且同源，固定 `sandbox="allow-scripts"` + `referrerpolicy="no-referrer"`。
- 新增 iframe **必须**显式写出 `sandbox` 属性并说明取值理由；外链 `target="_blank"` 现状 6 处全带 `rel`（`message.tsx` 两处 Markdown 链接与媒体链接为 `noopener noreferrer`，knowledge 预览与下载、站点目录、模型网关管理台为 `noreferrer`）——规范未单列该条，按现状记录，不构成偏离。

### 6.3 凭据与本地存储
- **禁止**将 API Key、Token、Secret 存入 `localStorage` 或 `sessionStorage`；认证 Token 仅通过 HttpOnly Cookie 传输，前端不直接读写；配置中的密钥占位符（如 `{env:RCS_SECRET_xxx}`）**不得**在前端代码中展开或替换；API Key 创建成功后仅展示一次，前端**不得**将明文 Key 持久化到任何本地存储。
- **唯一凭据类例外**（用户裁定保留，不得作为新代码先例）：系统 Master Key 存 `sessionStorage`（键 `rcs_admin_master_key`；实现 `packages/web-runtime/web/lib/admin-key.ts`，写入点 `@fenix/web-runtime/hooks/use-admin-key-gate` 的 `unlock()`，门组件 `@fenix/ui-components/config/AdminKeyGate`，5 处消费：sandbox / observer ×3 / model-management；经 `request()` 的 `bearerToken` 注入 `Authorization`，401 时调用方经 `fail()` 清 key 回门）；**只允许服务系统管理员页**，不得用于普通用户凭据，XSS 面由 §6.1 与 §6.2 控制 —— master key 改由服务端 HttpOnly Cookie 或仅内存态承载后，删除 `admin-key.ts` 及其全部消费方并同步删除本条登记。
- `localStorage` 合法用途白名单（除 `active_org_id` 与 master key 外，生产代码只碰这些键，表里是**全量**）：UI 维度与布局偏好 `fenix:artifacts-width` / `fenix:artifacts-layout`（`ChatArea`）、`fenix:file-tree-width`（`artifacts-files-workspace`）；面板开合 `acp-sidebar-open`（`chat-panel-ports.tsx`）；侧栏折叠 `agent-panel:sidebar-collapsed`（`AgentSidebar`，`AgentSidebarTree` 同属该折叠态）；语言 `rcs-lang`（i18n 检测器托管）；登录页偏好 `auth-preferred-method`（identity `web/lib/auth-preference.ts`）；主题无（全局强制亮色，见 §3.2，`theme` 键已不再被读写）。
- **组织 id（`active_org_id`）不在「便利」的范畴**：它决定请求归属哪租户，只允许经上下文读取（见 §3.3）——读点只有契约模块 `@fenix/web-runtime/lib/active-org`，写点只有身份的 `OrgContext.tsx`（`switchOrg` / `refreshOrgs` 的乐观写与回滚），两侧都有静态守卫钉住（`apps/web/src/__tests__/file-events-org-contract.test.ts`）。

### 6.4 敏感操作
- 删除、权限变更、组织转移等敏感操作**必须**经过二次确认，用 `ConfirmDialog` 且 `variant: "destructive"`。
- **禁止原生 `confirm()` / `window.confirm()`**：它阻塞主线程、无法本地化、样式不受控，且绕过 `ConfirmDialog` 的可访问性实现。
- 敏感操作的 API 调用**禁止**在 URL 中携带敏感参数（使用 POST body）。

### 6.5 现状偏离
- `dangerouslySetInnerHTML` 的 3 处调用点（knowledge 的 docx 分支与切片详情、检索高亮）全部走 `knowledge/web/lib/sanitize-html.ts` 的显式白名单（`sanitizeHighlightHtml` / `sanitizeRichHtml`，`sanitize-html.test.ts` 钉住白名单内容与接线）— 白名单里的 `class` 另行裁定后移除。
- 错误文案回显：Chat 域按稳定 `error.type` 映射字典（`public-error-text.ts`，协议侧「不得使用原始异常文本」，`public-error-i18n.test.ts` 守护）；域模块与页面的失败提示只上屏本包字典文案，守卫 `apps/web/src/__tests__/package-error-text-echo.test.ts` — 豁免清单与未收口项（§5.9）收口后移除。
- DOMPurify 的运行时行为在本仓测试环境测不出（happy-dom 限制，真实浏览器不受影响），清洗用例只断言白名单与接线（§11.2）— 测试环境能真实断言渲染后 HTML 后移除。
- `console.log`：仅 `use-cytoscape-graph.ts`（图谱初始化，含 2 条样例元素）与 `use-workflow-editor-events.ts`（Ctrl/Cmd+Shift+D 显式触发的调试入口）打用户数据，其余只打长度 / 大小 / 类型；`request.ts` 记完整 URL（含 query），全仓无调用方把凭据放进 query — 一旦出现凭据入日志或 query 即须脱敏并移除本条。

## 7. 错误边界
### 7.1 放置规则
- 用 `ErrorBoundary` 防止单个组件崩溃导致整个页面白屏：**每个独立功能面板**各自包裹（一个面板崩溃不影响其他面板），顶层根布局需兜底 ErrorBoundary，路由段也应有边界。
- 当前仓库**未使用** TanStack Router 的 `errorComponent` / `pendingComponent`（`__root.tsx` 只声明了 `notFoundComponent`）；新增路由时按现有手段（`ErrorBoundary` 组件）包裹，不要假定框架层已经兜住。
- 放置矩阵（落地情况见 §7.3）：根布局 `__root.tsx` 最外层 / 整个应用（关键·兜底）；Agent 面板布局 `_panel.tsx` 路由布局包裹 `{children}` 出口（关键·Agent 页整体）；`ChatPanel` 根组件（关键·核心功能）；`ArtifactsPanel` 根组件（非关键·可降级）；Sidebar `AgentSidebar` 根组件（非关键·可降级）。

### 7.2 降级策略
- `FallbackComponent` **必须**提供重试按钮（调用 `resetErrorBoundary`）。
- **降级 UI 不得渲染 `error.message`**（可能含内部实现细节与后端文案）：用固定的本地化文案，原始错误只进 `console.error`。
- `onError` **必须** `console.error` 记录原始错误；降级 UI 不应改变页面布局结构，避免级联布局崩溃；关键 / 非关键面板都可收缩为最小化状态（如一条错误提示条）；降级 UI 本身就是用户可见反馈，**不需要**额外 `toast.error`。

### 7.3 现状偏离
- 五处落点见 §7.1 矩阵，统一降级 UI 是 `@fenix/ui-components/ui/error-fallback` 的 `ErrorFallback`（props 只有 `resetErrorBoundary`，另有可选 `message` / `variant`，**刻意不接收 `error`**；**不依赖 `react-error-boundary`**，边界机制留在调用方）；根布局与布局路由用 `screen` 形态、三面板用 `panel` 形态，`_panel.tsx` 的边界在 `Suspense` **外**，三面板的边界裹在**导出处**，`onError` 一律 `console.error` 且不叠 `toast.error` — 属既定设计，实现变更时同步本条。
- 所有边界只做 `console.error`，**无任何上报通道**（仓库无既有上报设施）— 建立上报设施后移除。
- 新增页面 / 面板是否按 §7.1 包裹仍是**人工判断**（见 §11.3）；降级链路两条不变量由 `ui-components/web/__tests__/error-fallback.test.tsx`、`apps/web/src/__tests__/error-boundary-fallback.test.tsx` 钉住 — 加自动化检查后移除。

## 8. WebSocket / 实时通信
### 8.1 实时通道登记
- 前端与后端的实时连接**只有三条**（第三条 SSE 的前端消费方已注销，见下方本条），新增通道必须先在此登记（路径 / 建连点 / 鉴权方式 / 重连策略）；**不得在组件里拼装后端 URL（含 WebSocket URL）**——组件/页面目录下不得出现 `new WebSocket(` / `new EventSource(`，全仓前端源码里读 `active_org_id` 的只允许是契约模块一处（`apps/web/src/__tests__/file-events-org-contract.test.ts` 静态守护）。
- Chat 状态同步（Yjs）：`ws(s)://<host>/acp/yjs/:agentId`；建连点 `packages/agent-runtime/web/yjs/yjs-ws.ts` 的 `buildYjsUrl` → `@fenix/chat-channel` 的 `createYjsWsClient`；鉴权 会话 cookie + query `active_org_id`（经 §3.3 的组织契约读取），无 `Authorization` 头；重连 指数退避、终态码不重连（§8.3）。
- 文件树事件：`ws(s)://<host>/web/file-events`；域模块 `@fenix/resource-machine/web/api/file-events.ts` 的 `openFileEventsConnection`（URL / 订阅帧 / 帧解析都在此），组件 `use-file-tree-events.ts` 只消费入口；鉴权同上；退避、可见性与去抖是调用方策略。
- ~~Workflow 运行事件（SSE）~~：**前端消费方已注销（2026-09-29，2F）**——自研 workflow 前端的 `packages/resources/workflow/web/api/workflow-sse.ts` 随该前端整体删除，前端已无 `EventSource`，故本通道当前**没有前端建连点**。服务端 `/web/workflow/:id/events`（`createWebWorkflowSseRoutes`）仍在装配面上；接入新消费方时按原协议重新登记：`withCredentials: true`、每个 workflowId 一条独立 `EventSource`（禁止模块级单例）、前端以 `?fromSeqNum=` 续传、服务端另接受 `Last-Event-ID` 头。

### 8.2 连接生命周期
- **建立**：`gateway.handleOpen` 认证 → `ensureRunning` → 打开 Chat Doc / Session Doc → **`relayReady = true` 之前发送初始快照** → `connect` 握手 → flush 缓冲消息。
- **前端建连守卫**：`use-chat-panel-runtime.ts` 在登录态 loading / failed 时早退，无 `sessionId` 不建连——**登录态未就绪不得建连**。
- **断开**：`handleClose` 释放连接级资源与 relay 引用计数；Agent 实例存活时重连后由 `handleOpen` 重新同步；`relay_closed`（实例断链）才销毁 Doc。
- **心跳**：前端每 30s 发 `{ type: "keep_alive" }`（仅页面可见时），服务端每 30s 下发 `keep_alive`；**服务端不再因客户端心跳超时而关闭连接**（页面冻结暂停心跳是被允许的）；`ping` / `pong` 属 acp-link 机器侧协议，不是前端聊天通道的心跳。

### 8.3 重连与终态码
- 指数退避 `1s → 2s → 4s → 8s → 16s → 30s`，连续 6 次短连接（<30s）后停止（`chat-channel/src/transport/ws.ts` 的 `NO_RECONNECT_CODES` 与 `RECONNECT_DELAYS`）。
- **终态判定与 UI 语义的唯一来源是同一张策略表**：`chat-channel/src/transport/ws-close-codes.ts` 的 `WS_CLOSE_CODE_POLICY`（逐码两列 `stopReconnect` / `uiCode`，另有 `nonTerminalReason`）；`ws.ts` 的 `NO_RECONNECT_CODES` 与 `agent-runtime/web/yjs/yjs-ws.ts` 的 UI 语义视图都由它派生，**改行为只改这张表**；`chat-channel/src/__tests__/ws-close-codes.test.ts` 把两列钉成基线，改表必须两层基线一起过。传输层问「停不停自动重连」、UI 层问「给用户什么语义」，成员集合可以不同。
- **逐码**：4001 实例空闲被回收（`instance_idle_reclaimed`）停自动重连、**切回前台时自动重连**；4004 环境不可用（`environment_unavailable`）停自动重连、展示后手动恢复；4500 机器离线（`machine_unavailable`）停自动重连、手动重试；4501 客户端 keepalive 超时（`client_keepalive_timeout`）停自动重连、**切回前台时自动重连**；4502 spawn 永久拒绝（`spawn_rejected`，autoStart 关闭 / 并发上限等）停自动重连、按 `payload.code` 展示原因；4503 机器已被占用（`machine_already_connected`）停自动重连（`stopReconnect: true`）、`uiCode` **显式为 `null`**——缺口登记在该行（见 §8.6）；1013 连接数超限（`too_many_connections`）**不停自动重连**（`stopReconnect: false`，靠退避 + 短连接计数收敛），只有 UI 语义是终态（`uiCode: "too_many_connections"`）。
- **1013 例外**：慢消费者追赶超时（close reason = `slow consumer resync timeout`）**非终态**（`nonTerminalReason` 命中时 `uiCode` 取 `null`）——自动重连后走全量快照同步，**不得展示"须手动恢复"**。
- **零调用点（按「零消费导出保留 + 登记」口径处置，不要顺手删）**：`getTerminalYjsWsErrorCode()`（`agent-runtime/web/yjs/yjs-ws.ts`，只剩 `agent-runtime/web/__tests__/yjs-ws.test.ts` 逐码断言）与 `shouldAutoReconnectOnVisible()`（`agent-runtime/web/hooks/chat-visible-reconnect.ts`，只剩 `agent-runtime/web/__tests__/chat-visible-reconnect.test.ts`，该模块仍被 `use-chat-panel-runtime.ts:39` 取用其状态类型）；线上连接错误展示走服务端 `error` 帧 → `classifiedError` → `PublicErrorCard`（`use-chat-panel-runtime.ts:281`、`ChatPanel.tsx:120`），不经过这两个入口。

### 8.4 消息类型
- `action`（commandId 信封，前端 → 后端）：会话操作（send_prompt / cancel / load_session 等），`commandId` 幂等去重 + `accepted → committed` 两阶段 Ack；`keep_alive` 双向（可见性标记与心跳）；Yjs 增量（`chat:` / `session:`）后端 → 前端（双 Doc 状态广播）；`action_ack` / `action_error` 后端 → 前端（操作确认与稳定错误码）；`error` 后端 → 前端（连接级错误，携带终态码对应 `payload.code`）。
- **背压两端阈值都是 64 KB（字节）**：服务端某连接的发送积压 > 64 KB 时跳过该次发送，缓冲回落后**主动定向补发全量快照**（静默恢复，不需客户端重连），持续滞后 > 30s 才 `close(1013, "slow consumer resync timeout")`；前端 `chat-channel/src/transport/ws.ts` 的 `send()` 在 `bufferedAmount > 64 KB`（`SEND_BACKPRESSURE_THRESHOLD_BYTES`，单位仍是字节、与服务端同值）时**拒绝本次发送并返回 `false`**，不把帧排进无界缓冲（适配器不提供 `bufferedAmount` 时视为 0），**只拦排队**——不 `close`、不改连接状态、不碰 `WS_CLOSE_CODE_POLICY`（§8.3），`use-chat-panel-runtime.ts` 的 `sendViaWs` 把 `false` 走既有 `toast.error(wsSendFailed)`，心跳 `keep_alive` 被拒无副作用（§8.2）。

### 8.5 前端 Chat 约束
以下约束共同保证刷新恢复、多标签页一致性与消息不重复，**改动 Chat 相关代码前必须逐条确认**；Chat 状态消费用 `useChatState` / `useSessionState`（`@fenix/agent-runtime` 根出口）。
1. **`rcsSessionId` 必须确定性生成**（`createDeterministicRcsSessionId`），不得用 `Date.now()` 或随机值——否则刷新后旧 Y.Doc 不可达。
2. **初始快照先于 `relayReady`**：服务端在 WebSocket open 时先发 Chat Doc 与 Session Doc 快照（前端侧是 state-vector 帧）。
3. **重连时必须恢复 `acpSessionId`**：`handleOpen` 读 Session Doc 的 `root.session.sessionId` 回填 `entry.acpSessionId`（`chat-channel/src/channel/gateway.ts`）；旧 `chatMeta.activeSessionId` 字段已删除，不要再引用；同一 ACP session 的 `load_session` 必须跳过 Agent 全量回放。
4. **`cwd` 由服务端 translator 注入**；Agent status 到达前不得发送 `list_sessions`。
5. **Doc 名固定为 `chat:{rcsSessionId}` / `session:{rcsSessionId}`**，广播必须按 `rcsSessionId` 隔离，禁止全局广播会话数据。
6. **用户消息只由后端写入 Y.Doc**；前端不得维护第二份 `localUserEntries` 之类的本地副本，否则 Agent 回显会造成双写。
7. **会话切换与内容清理走「换代」**（`DocManager.replaceProjection`，`session-channel.ts` 调用）；`chat-writer.ts` 的 `clearSessionDocContent`（及专用的 `clearPeriTaskViews`）**已删除，不要恢复**（`docs/arch/19-yjs-chat-streaming.md` §4.2 明确禁止回到旧的清空流程）；也不要用 destroy + recreate 制造异步竞态；`create_session` 同样走换代，不沿用旧 Session Doc 的内容。
8. **同一 `instanceId + userId` 的多标签页共享一个 relay handle**，引用计数归零后才释放；切换 session 时同步同组客户端的 `acpSessionId`。
9. **连接上限与容量**：`YJS_MAX_CLIENTS` 默认 200，由 agent-runtime 模块声明并经 `AgentRuntimeModuleConfig.yjsMaxClients` 注入 chat-channel 装配（不要直读 env）；修改时必须保留限流、资源释放与单连接故障隔离。
10. **`ChatView` 与 `EntryRenderer` 使用 `React.memo`**，comparator 必须与调用方 prop 稳定性保持一致（`ChatView.tsx`、`EntryRenderer` 有显式逐 prop 比较，`MessageResponse` 比较 `children` + `envId`）；改动 props 时同步更新 comparator 与渲染测试。
11. **`@fenix/chat-channel` 根入口必须浏览器安全**：根入口只导出类型（`./types`）、schema、`public-error`、`chat-writer`、`yjs-store`、`protocol`、`transport`、`util`；服务端能力（channel 控制面、persist 持久化、state 聚合层）必须经 `@fenix/chat-channel/server` 导出；边界由 `packages/chat-channel/src/__tests__/chat-channel-browser-surface.test.ts` 静态走值导入图守护，`scripts/check-architecture.ts` 的 `browser-entry-server-import` 同时静态拦截 `@fenix/chat-channel/server`。

### 8.6 现状偏离
- `chat-channel/src/transport/ws-close-codes.ts` 的 4503 行（`stopReconnect: true` + `uiCode: null`，用户会看到「连接停了但没有任何提示」）— 补齐 `uiCode` 是**行为变化**，必须单独一批、单独授权，不得以「消缺口」为由顺手补；裁定前保持 `null`，并在策略表注释里保留指向本节的位置（§8.3）。

## 9. i18n 国际化
技术栈 `i18next` + `react-i18next` + `i18next-browser-languagedetector`，经 `initReactI18next` 全局单例装配（**不是** Provider）。

### 9.1 使用
- 从包出口取 NS、不写字面量：`const { t } = useTranslation(TASKS_V2_NS)`（`TASKS_V2_NS` 来自 `@fenix/resource-task/web/i18n`）；key 支持扁平 `t("title")` 与点号分层 `t("form.name.label")`。
- **插值必须用 `{{var}}`**：单花括号 `{var}` 会被 i18next 当作字面文本原样输出，是静默失败——界面上会出现裸露的 `{var}`；全仓仅 `model-management` 字典里 2 处 `{env:NAME}` 是**有意**的字面展示（配置占位符长相如此），除此之外不要引入单花括号。

### 9.2 命名空间与归属
- 命名空间与词条**归属 owner 包**，宿主只做装配：`apps/web/src/i18n/index.ts` 只登记、不写域内词条；`ns` 从已登记资源反推（`Object.keys(resources.en)`，不手写数组）；`fallbackLng: "en"`、`defaultNS: NS.COMMON`、检测顺序 `["localStorage", "navigator"]`、`lookupLocalStorage: "rcs-lang"`。
- 新增命名空间：owner 包内建 `packages/<group>/<pkg>/web/i18n/` 导出 `<DOMAIN>_NS` 与 `xxxResources`，经 `exports["./web/i18n"]` 公开；**NS 常量与字典拆成两个模块**（`namespace.ts` 只持常量、`index.ts` 持资源——`useTranslation(NS)` 不应把整份字典拉进模块图）；宿主 import 与两张资源表登记该包，消费方从包出口取 NS；只有真正跨资源包共用的词条才进 `@fenix/web-runtime/i18n/namespace` 或 `@fenix/ui-components/i18n/namespace`。
- `@fenix/ui-components` 的 i18n 出口是 **`./i18n` 与 `./i18n/namespace`**（不是 `./web/i18n`，写后者会解析失败）。

### 9.3 规则
- 禁止在 JSX 中硬编码用户可见字符串；命名空间用包的 `NS` 常量，不写字符串字面量；中文注释与 `console.log` 不受 i18n 限制。
- **en / zh 的 key 必须对称**，新增 key 同批补齐两种语言并同步包内 `web/__tests__/*-i18n.test.ts` 基线；**日期、数字、相对时间必须取当前 locale**，不得在共享组件中固定 `zh-CN`。
- **API / domain 错误按稳定 error code 映射到 message key**，未知错误使用安全通用文案，**不展示 raw message**（Chat 域是样板：`public-error-text.ts` + 协议侧约束 + `public-error-i18n.test.ts`）。
- **纯逻辑模块与后端不得 import UI i18n 或图标依赖**（见 §10）。

### 9.4 现状偏离
- 全仓级 key 对称无门禁（资源包侧已有 14 份 `packages/**/web/__tests__/*-i18n.test.ts`，宿主侧 `apps/web/src/__tests__/host-i18n.test.ts` 与 `public-error-i18n.test.ts`，但**跨包漏注册无专门检查**，`precheck` 也没有 i18n 步骤）— 补跨包注册检查与 `precheck` i18n 步骤。
- 无 `i18nKey` 编译期类型（无 `CustomTypeOptions`、无键生成脚本，写错的 key 只在运行时回退成字面量）— 引入 `CustomTypeOptions` 或键生成脚本。
- 硬编码用户可见文案：实测 505 行 / 103 文件（口径 = 字符串字面量 + JSX 文本中的中文，排除注释、测试与字典文件；含 1 条诊断日志串，属下一条「不属违规」类）；其中 `model-management` 的两个生产目录页（`AlgorithmsPage.tsx` 228、`VerticalModelsPage.tsx` 73）301 处 — 数据表改为从字典按 id 取（`models.algorithms.<id>.*` / `models.vertical.<id>.*`）。
- `ui-components/web/chat/mocks/**`（`mock-fixtures.ts` 31、`mock-conversation.ts` 42、`mock-stream-script.ts` 21、`mock-reducer.ts` 2）96 处 — **不入字典、保留**（demo / 用例的样本数据，非生产渲染路径）。
- `ui-components` chat 叙述层与少量默认值 30 处（`web/chat/narrators/*.ts` 的 `verb` 14 与兜底串 4 属**纯函数模块**；`HindsightToolCard.tsx` 6、`ChatHeader.tsx` 2、`chat-header-session-row.tsx` 的 `aria-label`、`useDragUpload.ts` 2、`CitationLink.tsx` 的 `title` 默认值同类）— 叙述层收 `t` 参数（`narrate(tool, t)`）、组件默认值改由调用方注入。
- `ui-components` 预览插件（`html-plugin.ts` 5、`native-pdf-plugin.ts` 2）7 处，已登记在该包 README「已知限制」第 12 条 — 插件工厂接受文案参数。
- `agent-config` 兜底文案 12 处（`AgentManagementPage.tsx` 8、`AgentHomePage.tsx` 3、`SiteFrame.tsx` 的 `title`）— 删掉 `defaultValue` 兜底（靠 i18n 测试保证键齐），默认提示模板与 `title` 改走 `t()`。
- 首屏静态加载全部语言与全部 namespace — 按 route / feature 拆分懒加载。
- 语言切换没有 UI 组件（检测、`rcs-lang` 持久化与 `fallbackLng` 都是宿主启动决策）— 补语言切换 UI。
- 复扫无需重判的两类（**不是用户可见文案、不属违规**）：开发诊断串 28 处（`console.warn/error` 与错误边界的 `onError`，含前述 1 条诊断日志串）；域模块内部错误消息 26 处（`web-runtime/api/request.ts`、machine `api/fs.ts`、knowledge / skill / observer 的 api 归一分支、`shell-navigation.ts`、`org-session.tsx`、identity `auth-client.ts`）— 界面一律按稳定 error code 取字典文案、**不展示 raw message**，这些串只进 `console` 与 `ApiError.message`。

## 10. 样式
- 默认 Tailwind v4 工具类，不写 CSS；配置只在 CSS 里：CSS-first、无 `tailwind.config.*`，token 写 `@theme`，自定义工具类 `@utility` 只在宿主 `apps/web/src/index.css`；**禁止 `@apply`**（当前零使用，勿引入）。**刻度在 `@theme` 按绝对像素落地**（2026-09-28 裁定）：本仓根字号 13px，而 Tailwind 刻度的默认值全是 rem 相对（`--spacing: 0.25rem` 只渲染 3.25px），两份 token 副本已把 `--spacing: 4px` 与 `--radius-*` / `--text-*` / `--container-*` 写成设计值的绝对像素——工具类在任何根字号下渲染的都是设计值（`p-4` = 16px、`w-60` = 240px、`text-sm` = 14px、`rounded-md` = 6px）。**不要**为「保住原值」把尺寸 / 间距 / 字号写进 CSS 或任意值（`FCP-WEB-01` 拦）；刻度要改就到 `@theme` 改。
- 两个入口、两份**逐字重复**的 token 副本：宿主 `apps/web/src/index.css` 与包入口 `packages/ui-components/web/styles/theme.css`（经 `@fenix/ui-components/styles.css` 暴露）——改 token 必须同批改两份，**没有任何一致性测试兜底**。
- `@source` 只扫 `packages/**/web/**`：组件源码放错位置（如 `packages/<pkg>/components/`）工具类**静默不生成**（症状是样式消失，不是报错），由 `scripts/__tests__/app-entry-paths.test.ts` 固化（见 §1）；`cn()` 唯一来自 `@fenix/ui-components/lib/cn`，不建第二份副本/别名；优先 token 类（`bg-surface-1` / `text-muted`），不写 `dark:`（见 §3.2：`.dark` 在应用内无法触发）。
- **独立 `.css` 只许四类**：① token 入口；② **第三方渲染覆盖表**——判据是第三方 DOM **无 className 挂载点**且第三方 CSS **未分层**，唯一实例 `ui-components/web/components/preview/overrides.css`，三条约束＝保留未分层靠导入顺序取胜、**拒绝 `!important`**（全仓现有 6 处 `!` 属待清理遗留，不要增加）、覆盖选择器必须带第三方类名前缀（如 `ofv-*`）；③ **深层样式伴随表**——与源文件同目录同名、由持有样式的模块顶部 `import`，承载**无法用扁平工具类表达**的选择器嵌套／复合表达式值／无标准变体的媒体查询（2026-09-28 令牌层裁定后**不再承载 dimensional 取值**：尺寸／间距／字号／圆角一律走 token 化的刻度类，见上一条；**目标挂不上类名时**（伪元素、第三方／生成 DOM、非标准断点媒体块、结构选择器）取值以 `var(--token)` / `calc(var(--spacing) * N)` 的 token 引用形态给出、**不写 px 字面量**；刻度缺失先在 `@theme` 补档，自有档段用 `@theme static` 强制产出——`var()` 引用不保活，漏档即静默失效（踩坑记录见 `docs/design/issues/2026-09-28-web-style-closure-defects.md` §五）；曾按「绝对像素几何」写回本类的声明已整体撤回 `className`），类名优先沿用源选择器名、否则 `kebab-case` 语义名，**不包 `@layer`**，每处下沉逐条确认胜负关系（会被消费方 `className` 覆盖者不得整条下沉）；判据与口径见 `forbidden-code-patterns.md` §「存量清理结果」，门禁 `bun run check:web-style`（本类表里的 px / rem 与颜色字面量由 `FCP-WEB-07/08` 拦截，台账即清理清单）；④ 迁移未完成的历史页面级样式表——**不鼓励**。
- **新增 `.css` 只用前三类**：现有形态另含 `ui-components/web/chat/css/*.css`（2 份 / 137 行，模块级表）；确实要写 CSS 时放组件同目录、与组件同名，**不要新增页面级样式表**。
- 图标：通用图标只用 `lucide-react`、**禁止内联 SVG**；模型图标走 `<ModelIcon modelId size variant>`（`model-management/web/components/model-icon/ModelIcon.tsx`）、**禁止直接 `import "@lobehub/icons"`**（`model-icon-boundary` 强制，见 §11.2）；**纯逻辑模块不得依赖 UI 图标包**（也不得间接加载：`@lobehub/icons` → `antd-style` 加载期裸调 `matchMedia`，无 DOM 的 `bun test` 进程加载即崩）。
- 字体：系统字体栈，**禁止外部字体链接与 `@font-face`**；`--font-sans` / `--font-display` / `--font-body` 三者同值、`--font-mono` 独立，均应用在 `html, body`。

### 10.1 现状偏离
- **计数口径**（即 §10 四类里剩下的第四类）：枚举 `find apps/web/src -name '*.css'`、`find packages -path '*/web/*' -name '*.css'`（排除 `node_modules` / `dist`），**计入**无同目录同名 `.tsx` / `.ts` 兄弟的 `.css`；**排除** ① token 入口（宿主 `index.css` 710 行——除 `@theme` 外另含「宿主壳残余样式」段、`theme.css` 377 行）、② `overrides.css`（48 行）、③ 类别 ③ 伴随表（73 份 / 5766 行）、④ `ui-components/web/chat/css/*.css`（2 份 / 137 行）；**口径外** `ui-sandbox/`、`docs/**`、`e2e/playwright-report/**`、`tmp/**`、`.worktrees/**` 与包内 demo `demo.css`。**改本节就重跑该分类脚本重算，不要用「上次的数字 ± 本批增删」维护。**
- **`tw-animate-css` 声明了依赖但源仓库从未 `@import` 它**（仅包内 demo 导入，已登记在该包 README 已知限制）— 应用入口 `@import` 它后移除。

## 11. 开发落地清单
### 11.1 提交前自检
- **门禁**：`bun run precheck` 通过（15 步，见 §11.2）；前端改动额外跑 `bun run build:web`（后端从 `apps/web/dist/` 挂载静态资源，类型检查通过 ≠ 构建通过）；前端用例随 `precheck` 末波的三批 `bun test`（`apps/server/src/__tests__/` + `scripts/__tests__/` + `platform-sdk`、`packages/`、`apps/web/src/__tests__/`）跑过；迭代时可先单独跑 `bun test packages/<该包>/web/__tests__/`，交付前仍以整批为准；每个 `test(...)` 上方有一行中文注释说明行为与业务意图。
- 用户可见字符串全部走 `t()`、插值用 `{{var}}`、en / zh key 对称；导航用 `useNavigate()` / `<Link>`，不用 `window.location` 写操作。
- 新增页面：路由壳放 `apps/web/src/routes/agent/_panel/`、实现放 owner 包 `web/pages/` 并经懒加载引入（见 §2.5），已在 `web/contribution.ts` 加导航项并补包字典；新增路由后跑过一次 dev 或 build（`routeTree.gen.ts` 才会重生）。
- API 调用经域模块，且已 `unwrap()` 或显式判断 `success`；组件中无裸 `fetch`、无自拼后端 URL；失败没有被映射成 empty 或成功状态；Loading 态有骨架屏守卫、Empty 态有占位提示。
- 跨包引用经各包 `exports`、未新增指向 `packages/**` 的别名、vite 与根 tsconfig 两张别名表同步；单文件未超 500 行；改动过 UI 结构时 `packages/ui-components` 的 `web/index.ts` 与 `exports` 已同批更新。
- 表单用 `FormDialog` + `formConfig`（react-hook-form + zod），不手写 `useState` 校验；Dialog `onOpenChange` 中清理状态、表单重置用 `key`；`dangerouslySetInnerHTML` 不经清洗不得使用、新增 iframe 显式声明 `sandbox`；无 API Key / Token 存入 localStorage、无原生 `confirm()`。

### 11.2 自动化检测
`bun run precheck` = `scripts/ci.ts` 的 15 步，**分三波执行**（波内受限并发；步骤定义与取消合并的理由见脚本头部注释）：
1. `biome`：`biome check --write`，一次完成格式化、import 排序与安全修复（写盘，故须独占先行）；
2. 静态门禁：`generate:module-registry --check`、`generate:web-contributions --check`、`check:root-owner-inventory`、`check:schema-ddl-drift`、`env-example --check`、`architecture`、`check:web-style`、tsc(server)、tsc(web)、tsc(packages)、`check:dependencies`；
3. 三批 `bun test`：`apps/server/src/__tests__/ scripts/__tests__/ packages/platform/platform-sdk/src/__tests__/`、`packages/`、`apps/web/src/__tests__/`。

三步 tsc 均带 `--incremental`，`tsbuildinfo` 落在 `node_modules/.cache/fenix-precheck/`：它是可随时删除的加速缓存，不参与门禁判定。

单任务收尾用 `bun run fastcheck`（`scripts/fastcheck.ts`）：静态部分与 precheck 共用 `scripts/lib/check-gates.ts` 的同一份步骤定义（三条生成物门禁同样是 `--check` 只读形态，不会替你把生成物写最新），类型检查改用 `tsc-rs` 加速且不带增量缓存（探活失败回退官方 `tsc`；发布门禁 precheck 始终用官方 `tsc`），测试只跑 `scripts/lib/affected-tests.ts` 判定的受影响范围（按改动路径命中宿主 / web / 具体包，包改动再沿反向依赖纳入消费方包）；`--no-tests` 退化为纯静态快检。它不替代 precheck：反向依赖闭包不含 `apps/server` / `apps/web` 两个宿主消费方，宿主侧集成回归只有全量三批测试能覆盖。

#### 硬红线（`scripts/check-architecture.ts`，零容忍）
- `browser-entry-server-import`：浏览器生产代码（`apps/web/src/**`、各包 `web/**`）不得导入 `node:*`、`@server/*`、`@fenix/chat-channel/server`（测试代码可用服务端测试工具）；`package-no-internal-imports`：跨 workspace 包不得绕过公开导出访问 `@fenix/*/src/*`、`@fenix/*/web/src/*`，也不得用相对路径越界到其他包的 `src/`、`web/src/`、`db/`。
- `zod-v4-entrypoint`：Zod 必须从 `zod/v4` 导入；`model-icon-boundary`：`@lobehub/icons` 只能由 model-management 的 `model-icon` 组件封装。
- `frontend-no-legacy-api-prefix`：经 `request()` 调用时不得使用 `/v1`、`/v2` 历史前缀；`backend-no-route-imports`：（后端）Service / Repository 不得反向依赖 Route。

#### 边界规则（台账制，`scripts/lib/architecture-boundary-rules.ts`）
- 四条规则：`undeclared-workspace-dependency`（导入 workspace 包但未声明依赖）、`apps-boundary`（`packages/**` 不得依赖各 app）、`special-dependency`（跨类别依赖矩阵 + 具体包禁则）、`web-package-not-to-app`（`packages/**/web/**` 不得用宿主别名或相对路径越界到 `apps/web`）。
- 台账制：只有**未登记的新增违规**才失败，豁免清单在 `scripts/architecture/exceptions.json`（逐条带 owner 与移除条件）；**已不再违规的条目要求删除**，不要让豁免过期。

#### dependency-cruiser（`bun run check:dependencies`）
- 规则名：`no-circular`、`no-cross-package-src:<pkg>`（每包一条）、`no-cross-package-db:<pkg>`（每包一条）、`platform-not-to-agent-runtime-resources-apps`、`agent-runtime-not-to-resources`、`ce-not-to-ee`；`<pkg>` 取工作区路径（如 `no-cross-package-src:packages/resources/task`）。
- 别名判定基准是**仓库根 `tsconfig.json` 的 `paths`**（见 §1.2）。

#### 浏览器安全入口守卫
各包 `web/__tests__/*-browser-surface.test.ts`（当前 13 份，全在 `packages/resources/*`；`chat-channel` 的对应文件在 `src/__tests__/`）静态走根出口的**值导入图**，断言图中不出现服务端模块与 `node:*`；**新增包外运行时依赖时必须同步登记到该测试的白名单**。

#### 前端测试约定
- 框架是 `bun test`（无 vitest / jest）；`bunfig.toml` 只 preload 服务端侧垫片，**没有全局 DOM**。
- 需要 DOM 的用例自建 happy-dom Window，唯一入口是 `@fenix/ui-components/testing` 的 `initializeHappyDomWindow`（`HTMLElement` 与 `customElements` 必须**成对**注入，否则 streamdown 链路在用例之间崩）；只测关键交互、状态与数据流，不写纯 UI 结构断言或仅重复类型检查的测试。
- **DOMPurify 在 happy-dom 下清洗不动，别写「渲染后的 HTML」类断言**：清洗用例只断言白名单内容与接线，参考 `knowledge/web/__tests__/sanitize-html.test.ts`（见 §6.5）。
- **`react-i18next` 替身必须返回稳定的 `t`**：不得在 `useTranslation()` 里每次渲染新建对象或函数，否则组件反复拉取（假阳性，生产不复现）；现存 10 份 `useTranslation: () => ({ ... })` 写法，改到相关组件时顺手收口。
- **radix `Portal` 内容在 happy-dom 用例里挂不上，别写「弹窗内的 XX」类断言**：改断言弹窗内容所复用的子组件（如 `MemoryDetailPanel`），弹窗自身只断言取数是否发出、失败是否记录；或 `mock.module` 出**保持 open/onOpenChange 语义**的就地渲染替身（先例 `ConfirmDialog` / `Sheet`，见 `workflow-v2/web/__tests__/workflow-list-page.test.tsx`）。

### 11.3 尚未自动化的规则
靠人工 review、不靠工具兜底；口径 `apps/web/**` + `packages/**/web/**`。

- 组件中裸调 `fetch()` / `XMLHttpRequest` / `WebSocket` / `EventSource` — 未自动化；例外点登记制（§5.3），生产命中 **11 个文件** ＝ 9 处登记 + `request.ts` + 仅注释提及的 `prompt-input-context.tsx`；「`fetch` 被当值传递」形态由 `ui-components/web/__tests__/preview-fetch-injection.test.ts` 钉住；服务端与运行时包（`plugin-{ccb,opencode,peri}` 的 `createWebSocket`、`acp-link`、`chat-channel/src/transport/ws.ts`、`workflow-engine` 的 API 节点执行器、`acp-runtime-cli`）与包内 demo 不在管辖内。
- 直接 `await` 域模块不解包 — 未自动化，签名层面无法区分（两代写法见 §5.9）。
- `window.location` 写操作 — 无**全仓**门禁；生产代码零命中（原先唯一的局部守卫 `workflow/web/__tests__/workflow-page-route.test.ts` 已随自研工作流前端于 2026-09-29 删除，现无守卫）。
- `dangerouslySetInnerHTML` 不经清洗 — 未自动化；仍是 **3 处**（knowledge 的 docx / 切片 / 检索高亮），全部经 `web/lib/sanitize-html.ts` 显式白名单，由 `knowledge/web/__tests__/sanitize-html.test.ts` 钉住。
- `localStorage` 读写组织身份 — 未自动化；**直读点 0、直写点 0**（读＝契约模块 `@fenix/web-runtime/lib/active-org`，写＝身份的 `OrgContext.tsx`），由 `apps/web/src/__tests__/file-events-org-contract.test.ts` 钉住。
- 原生 `confirm()` / `alert()` / `prompt()` — 未自动化；全仓**零命中**（4 处已迁 `ConfirmDialog`），新增只能靠 review。
- 凭据写入 `localStorage` / `sessionStorage` — 未自动化（§6.3 硬红线）；**唯一凭据是已登记的 master key** `rcs_admin_master_key`（写入点只有 `use-admin-key-gate` 的 `unlock`；其余键均为 UI 偏好 / 布局 / `rcs-lang` / `active_org_id`），全仓无 `document.cookie` 读写、无 `indexedDB`。
- 外链 `target="_blank"` 的 `rel` — 未自动化（规范未单列）；全仓 6 处**全带 `rel`**，按现状记录，不构成偏离。
- `console.error` 缺配对用户可见反馈 — 未自动化，判据见 §5.8、残留见 §5.9；错误边界是已豁免的一类（§7.1）。
- 日志与提示里的敏感信息 — 未自动化；`console.*` 不含 token / key / 密码；`request.ts` 记完整 URL（含 query），无调用方把凭据放进 query，故不脱敏（见 §6.5）。
- 错误边界的放置矩阵（§7.1） — 未自动化，新增页面 / 面板是否包裹仍靠 review；五处已落地，两条不变量由 `ui-components/web/__tests__/error-fallback.test.tsx` 与 `apps/web/src/__tests__/error-boundary-fallback.test.tsx` 钉住（见 §7.3）。
- iframe 的 `sandbox` 取值 — 未自动化，逐处取值见 §6.2 的表（`IframePreview` 为 `allow-scripts allow-popups` 且 `sandbox` 不可被 props 覆盖；用户站点保留 `allow-same-origin` + `referrerPolicy`；UGC HTML 预览只 `allow-scripts`）。
- 单文件 500 行上限 — 未自动化（`precheck` 不管）；前端生产文件已**清零**（超限 0、最大 496，复测命令与口径见 §4.8），新增模块仍靠 review。
- 组件重复开发检测 — 未自动化；包内同名同形态已收敛（workflow 的 `CollapsibleGroup`，见 §4.8），**跨包**重复仍无门禁，判据「第二个包开始消费就该下沉」（§4.1）。
- i18n 全仓 key 对称、`[object Object]` — 包级与宿主各有测试（14 份 `packages/**/web/__tests__/*-i18n.test.ts` + `ui-components` 的 `i18n-barrel.test.ts` + 宿主 `host-i18n.test.ts`），**跨包漏注册**无门禁（见 §9.4）。
- import 分组顺序、格式化 — 已由 Biome 覆盖（`precheck` 的 `biome` 步骤，`biome check --write` 一次完成 import 排序 + 格式化 + 安全修复）。
