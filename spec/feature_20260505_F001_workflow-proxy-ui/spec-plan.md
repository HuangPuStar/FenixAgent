# 工作流代理与 UI 嵌入 执行计划

**目标:** 通过双层反向代理将 acpx-g 工作流引擎 UI 嵌入 RCS 控制面板，统一认证入口

**技术栈:** Hono (reverse proxy)、React (iframe container)、Bun test

**设计文档:** spec/feature_20260505_F001_workflow-proxy-ui/spec-design.md

## 改动总览

- Task 1 创建反向代理路由文件 `workflow-proxy.ts`，在 `config.ts` 中添加 `acpxGUrl` 配置项，在 `index.ts` 中挂载两组代理路由（`/workflow-ui` 和 `/api/v1`）。Task 2 依赖 Task 1 提供的 `/workflow-ui/*` 和 `/api/v1/*` 端点来构建 iframe 容器页面。
- 两组路由需分别挂载到 app 根级别（非 `/web` 前缀下），因为 acpx-g 的 JS 使用绝对路径 `/api/v1/*` 发起请求，浏览器不会自动带上 `/web` 前缀。

---

### Task 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**
- [x] 验证后端构建和测试工具可用
  - 运行: `bun run typecheck`
  - 预期: 类型检查通过，无错误
- [x] 验证前端构建工具可用
  - 运行: `bun run build:web 2>&1 | tail -5`
  - 预期: 输出包含 "built in" 且无 error
- [x] 验证测试框架可用
  - 运行: `bun test src/__tests__/store.test.ts`
  - 预期: 测试框架正常工作，无配置错误

**检查步骤:**
- [x] 后端类型检查通过
  - `bun run typecheck`
  - 预期: 无类型错误
- [x] 前端构建成功
  - `bun run build:web 2>&1 | tail -5`
  - 预期: 输出包含 "built in" 且无 error

---

### Task 1: 后端工作流反向代理

**背景:**
[业务语境] — 在 RCS 后端新增反向代理，将浏览器的 `/workflow-ui/*` 静态资源请求和 `/api/v1/*` API 请求转发到 acpx-g 服务（localhost:8848），实现统一认证入口
[修改原因] — 当前 acpx-g 独立运行在 8848 端口，无认证保护；需要通过 sessionAuth 中间件保护所有访问
[上下游影响] — Task 2 的 iframe 页面依赖本 Task 提供的 `/workflow-ui/*` 和 `/api/v1/*` 端点；本 Task 依赖 Task 0 的环境准备

**涉及文件:**
- 新建: `src/routes/web/workflow-proxy.ts`
- 修改: `src/config.ts`
- 修改: `src/index.ts`

**执行步骤:**
- [x] 在 config.ts 中添加 acpxGUrl 配置字段 — 为反向代理提供目标地址
  - 位置: `src/config.ts` 的 `config` 对象内，在 `jwtExpiresIn` 字段之后（~L23）
  - 添加字段: `acpxGUrl: process.env.ACPX_G_URL || "http://localhost:8848"`
  - 原因: acpx-g 服务地址需要可通过环境变量覆盖，默认连接本地 8848 端口

- [x] 新建 workflow-proxy.ts 反向代理路由文件 — 实现请求转发核心逻辑
  - 位置: 新建 `src/routes/web/workflow-proxy.ts`
  - 文件结构:
    ```typescript
    import { Hono } from "hono";
    import { stream } from "hono/streaming";
    import { config } from "../../config";
    import { sessionAuth } from "../../auth/middleware";

    /** 将请求转发到 acpx-g 并流式返回响应 */
    async function proxyToAcpxG(
      targetPath: string,
      request: Request,
      methodOverride?: string,
    ): Promise<Response> {
      const targetUrl = `${config.acpxGUrl}${targetPath}`;
      const init: RequestInit = {
        method: methodOverride || request.method,
        headers: { ...request.headers, Host: new URL(config.acpxGUrl).host },
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
      }
      try {
        const res = await fetch(targetUrl, init);
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: { type: "bad_gateway", message: `acpx-g unreachable: ${err.message}` } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // 静态资源代理：挂载到 /workflow-ui，转发到 acpx-g 根路径
    // 注意：Hono app.route("/prefix", subApp) 挂载后，c.req.path 仍返回完整路径
    // 需使用路由通配参数获取去掉前缀后的相对路径
    export const workflowStaticApp = new Hono();
    workflowStaticApp.use("/*", sessionAuth);
    workflowStaticApp.all("/", async (c) => {
      return proxyToAcpxG("/", c.req.raw);
    });
    workflowStaticApp.all("/:path{.*}", async (c) => {
      const path = c.req.param("path");
      return proxyToAcpxG(`/${path}`, c.req.raw);
    });

    // API 代理：挂载到 /api/v1，转发到 acpx-g 的 /api/v1/*
    export const workflowApiApp = new Hono();
    workflowApiApp.use("/*", sessionAuth);
    workflowApiApp.all("/", async (c) => {
      return proxyToAcpxG("/api/v1", c.req.raw);
    });
    workflowApiApp.all("/:path{.*}", async (c) => {
      const path = c.req.param("path");
      return proxyToAcpxG(`/api/v1/${path}`, c.req.raw);
    });
    ```
  - 关键逻辑:
    - `proxyToAcpxG` 是共享的代理 helper，接收目标路径和原始请求，构造新的 fetch 请求并流式透传响应
    - 转发时覆盖 Host header 为 acpx-g 的 host，避免 CORS 问题
    - 非 GET/HEAD 请求透传 request body
    - acpx-g 不可达时返回 502 + JSON 错误信息
    - 导出两个独立的 Hono app（`workflowStaticApp` 和 `workflowApiApp`），分别挂载到不同前缀
  - 原因: acpx-g 的 JS 使用绝对路径 `/api/v1/*`，无法通过单一 `/web` 前缀路由捕获，必须分两组挂载到根级别

- [x] 在 index.ts 中导入并挂载 workflow-proxy 路由 — 将代理路由注册到 HTTP 服务器
  - 位置: `src/index.ts`，在 import 区域（~L22 `import webChannels` 之后）添加导入语句
  - 添加导入: `import { workflowStaticApp, workflowApiApp } from "./routes/web/workflow-proxy";`
  - 位置: `src/index.ts`，在路由挂载区域（~L124 `app.route("/web", webChannels)` 之后）添加挂载
  - 添加挂载:
    ```typescript
    // Workflow proxy routes (forward to acpx-g)
    app.route("/workflow-ui", workflowStaticApp);
    app.route("/api/v1", workflowApiApp);
    ```
  - 原因: 两组路由需在 `/web/*` 路由之后、`/acp/*` 路由之前挂载；`/api/v1` 挂载在根级别，与 `/api/auth/*`（better-auth）路径不冲突

- [x] 为 workflow-proxy 反向代理编写单元测试
  - 测试文件: `src/__tests__/workflow-proxy.test.ts`
  - 测试场景:
    - 静态资源代理: GET `/workflow-ui/style.css` 返回 200，请求被转发到 acpx-g 的 `/style.css`
    - API 代理: GET `/api/v1/workflows` 返回 200，请求被转发到 acpx-g 的 `/api/v1/workflows`
    - POST 请求透传 body: POST `/api/v1/workflows` 携带 JSON body，转发到 acpx-g 的 `/api/v1/workflows`
    - 未认证返回 401: 无 session cookie 时访问 `/workflow-ui/` 和 `/api/v1/workflows` 均返回 401
    - acpx-g 不可达返回 502: 模拟 fetch 失败时返回 502 + JSON 错误信息
  - Mock 策略:
    - mock `../../config` 使 `config.acpxGUrl` 指向一个可控的 URL
    - mock `fetch`（全局）模拟 acpx-g 的响应
    - mock `../../auth/middleware` 使 `sessionAuth` 直接调用 `next()`（已认证）或返回 401
  - 运行命令: `bun test src/__tests__/workflow-proxy.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 验证 config.ts 包含 acpxGUrl 字段
  - `grep -n "acpxGUrl" /Users/konghayao/code/pazhou/remote-control-server/src/config.ts`
  - 预期: 输出包含一行，字段从 ACPX_G_URL 环境变量读取
- [x] 验证 workflow-proxy.ts 导出两个 Hono app
  - `grep -n "export" /Users/konghayao/code/pazhou/remote-control-server/src/routes/web/workflow-proxy.ts`
  - 预期: 输出包含 `workflowStaticApp` 和 `workflowApiApp` 两个导出
- [x] 验证 index.ts 挂载了两组代理路由
  - `grep -n "workflow" /Users/konghayao/code/pazhou/remote-control-server/src/index.ts`
  - 预期: 输出包含 import 行和 `app.route("/workflow-ui"` 与 `app.route("/api/v1"` 两行挂载
- [x] 验证代理路由挂载路径与现有路由不冲突
  - `grep -n '"/api' /Users/konghayao/code/pazhou/remote-control-server/src/index.ts`
  - 预期: `/api/auth/*`（better-auth）和 `/api/v1`（workflow proxy）共存，路径前缀不同不冲突
- [x] 运行单元测试
  - `bun test src/__tests__/workflow-proxy.test.ts`
  - 预期: 所有测试通过，无报错
- [x] 运行类型检查
  - `bun run typecheck`
  - 预期: 无类型错误

---

### Task 2: 前端工作流页面与导航

**背景:**
[业务语境] — 用户通过 RCS 控制面板的侧边栏导航访问工作流页面，在 iframe 中使用 acpx-g 的原生工作流编辑器和运行记录界面
[修改原因] — 当前侧边栏没有工作流入口，App.tsx 路由也没有对应的 view，用户无法从控制面板访问 acpx-g
[上下游影响] — 本 Task 依赖 Task 1 提供的 `/workflow-ui/*` 代理端点作为 iframe src；本 Task 的输出为 Task 3 验收提供可测试的前端页面

**涉及文件:**
- 新建: `web/src/pages/WorkflowPage.tsx`
- 修改: `web/src/components/shell/Sidebar.tsx`
- 修改: `web/src/App.tsx`

**执行步骤:**
- [x] 新建 WorkflowPage.tsx iframe 容器页面 — 提供全屏 iframe 嵌入 acpx-g UI
  - 位置: 新建 `web/src/pages/WorkflowPage.tsx`
  - 组件导出名: `WorkflowPage`
  - 页面结构：全屏 iframe，src 为 `/workflow-ui/`（尾部斜杠确保 acpx-g 的相对路径资源正确解析为 `/workflow-ui/style.css` 等）
  - 无顶部标题栏（acpx-g 自带顶部栏），iframe 直接铺满父容器高度
  - 状态管理：`useState<boolean>` 控制 `loading` 和 `error` 两个状态
  - iframe `onLoad` 回调将 `loading` 设为 `false`
  - iframe `onError` 回调将 `error` 设为 `true`，页面显示错误提示
  - loading 时显示 spinner（复用 App.tsx 中已有的 spinner 样式: `h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin`）
  - error 时显示错误提示文字，包含重试按钮（重新加载 iframe）
  - 样式约束：不使用外部字体链接，使用系统原生字体栈
  - 伪代码:
    ```tsx
    import { useState, useRef } from "react";

    export function WorkflowPage() {
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(false);
      const iframeRef = useRef<HTMLIFrameElement>(null);

      const handleReload = () => {
        setLoading(true);
        setError(false);
        if (iframeRef.current) {
          iframeRef.current.src = "/workflow-ui/";
        }
      };

      return (
        <div className="flex h-full flex-col">
          {loading && (
            <div className="flex h-full items-center justify-center gap-3">
              <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
              <p className="text-sm text-text-muted">正在加载工作流引擎...</p>
            </div>
          )}
          {error && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-sm text-text-muted">工作流引擎连接失败，请确认 acpx-g 服务已启动</p>
              <button onClick={handleReload} className="text-brand text-sm underline">重试</button>
            </div>
          )}
          <iframe
            ref={iframeRef}
            src="/workflow-ui/"
            onLoad={() => setLoading(false)}
            onError={() => setError(true)}
            className={loading || error ? "hidden" : "flex-1 w-full border-0"}
            title="工作流引擎"
          />
        </div>
      );
    }
    ```

- [x] 在 Sidebar.tsx 添加工作流导航项 — 让用户从侧边栏进入工作流页面
  - 位置: `web/src/components/shell/Sidebar.tsx` L1-13 的 lucide-react import 语句
  - 在已有的图标导入列表（`KeyRound` 之后）追加 `Workflow`
  - 位置: `NAV_GROUPS` 常量的「配置」分组 items 数组（L54-60），在 `{ id: "channels", ... }` 之后、`{ id: "apikeys", ... }` 之前插入
  - 新增条目: `{ id: "workflow", label: "工作流", icon: Workflow }`

- [x] 在 App.tsx 集成 workflow 路由 — 将 WorkflowPage 接入路由系统
  - 位置: `web/src/App.tsx` L39-41 的 lazy import 块，在 `ChannelsPage` lazy import 之后追加:
    ```tsx
    const WorkflowPage = lazy(() =>
      import("./pages/WorkflowPage").then((m) => ({ default: m.WorkflowPage })),
    );
    ```
  - 位置: `parseConfigView` 函数内的 `configViews` 数组（L44），在 `"channels"` 之后追加 `"workflow"`
  - 位置: `parseRoute` 函数内的 `configViews` 数组（L74），在 `"channels"` 之后追加 `"workflow"`
  - 位置: `ViewId` 类型联合（L49-60），在 `"channels"` 之后、`"environments"` 之前追加 `"workflow"`
  - 位置: 条件渲染链（L202-226），在 `configView === "channels"` 分支（L214-215 `<ChannelsPage />`）之后、`configView === "environments"` 分支（L216）之前插入:
    ```tsx
    ) : configView === "workflow" ? (
      <WorkflowPage />
    ```

- [x] 为 WorkflowPage 及路由集成编写单元测试
  - 测试文件: `web/src/__tests__/workflow-page.test.tsx`
  - 测试场景:
    - WorkflowPage 组件导出正确: 读取 `web/src/pages/WorkflowPage.tsx`，验证包含 `export function WorkflowPage`
    - WorkflowPage iframe src 指向 `/workflow-ui/`: 读取组件源码，验证包含字符串 `/workflow-ui/`
    - Sidebar 包含工作流导航项: 读取 `web/src/components/shell/Sidebar.tsx`，验证包含 `id: "workflow"` 且 `label: "工作流"`，且导入了 `Workflow` 图标
    - App.tsx 包含 workflow 路由: 读取 `web/src/App.tsx`，验证 `parseConfigView` 的 `configViews` 包含 `"workflow"`，`ViewId` 类型包含 `"workflow"`，条件渲染包含 `configView === "workflow"` 和 `<WorkflowPage />`
    - App.tsx lazy import WorkflowPage: 验证源码包含 `import("./pages/WorkflowPage")`
  - 运行命令: `bun test web/src/__tests__/workflow-page.test.tsx`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 验证 WorkflowPage 文件已创建且导出正确
  - `grep -c "export function WorkflowPage" web/src/pages/WorkflowPage.tsx`
  - 预期: 输出 1
- [x] 验证 Sidebar 包含工作流导航项
  - `grep "workflow" web/src/components/shell/Sidebar.tsx`
  - 预期: 包含 `Workflow` 图标导入和 `id: "workflow"` 导航条目
- [x] 验证 App.tsx 路由集成完整
  - `grep -c "workflow" web/src/App.tsx`
  - 预期: 输出 >= 5（lazy import、两个 configViews 数组、ViewId 类型、条件渲染分支中的两处 "workflow"）
- [x] 验证前端构建无错误
  - `bun run build:web 2>&1 | tail -5`
  - 预期: 输出包含 "built in" 且无 error
- [x] 验证单元测试通过
  - `bun test web/src/__tests__/workflow-page.test.tsx`
  - 预期: 所有测试通过

---

### Task 3: 工作流代理与 UI 嵌入 验收

**前置条件:**
- acpx-g 服务已启动：`bash restart-acpx-g.sh`（运行在 localhost:8848）
- RCS 后端已启动：`bun run dev`
- 前端已构建：`bun run build:web`

**端到端验证:**

1. [x] 运行完整测试套件确保无回归
   - `bun test src/__tests__/workflow-proxy.test.ts && bun test web/src/__tests__/workflow-page.test.tsx`
   - 预期: 所有测试通过
   - 失败排查: 检查 Task 1 和 Task 2 的测试步骤

2. 验证后端代理路由可访问（需 sessionAuth）
   - `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/workflow-ui/`
   - 预期: 返回 401（未认证），不返回 404
   - 失败排查: 检查 Task 1 的 index.ts 挂载是否正确

3. 验证前端页面可访问（浏览器登录后）
   - 登录 RCS 控制面板（`http://localhost:3000/ctrl/`）
   - 点击侧边栏「工作流」导航项
   - 预期: 页面显示 acpx-g 工作流编辑器界面
   - 失败排查: 检查 Task 2 的 Sidebar 导航项和 App.tsx 路由

4. 验证 acpx-g UI 功能正常
   - 在工作流页面中点击「运行记录」标签
   - 预期: 运行记录列表正常加载
   - 切换回「工作流编辑器」标签
   - 预期: 编辑器正常加载，可见工作流模板列表
   - 失败排查: 检查 Task 1 的代理路径重写逻辑，确认 `/api/v1/*` 和 `/workflow-ui/*` 转发正确

5. 验证 acpx-g 服务不可达时的错误处理
   - 停止 acpx-g 服务
   - 刷新工作流页面
   - 预期: iframe 加载失败，页面显示"工作流引擎连接失败"提示和重试按钮
   - 失败排查: 检查 Task 2 的 WorkflowPage error 状态处理

6. [x] 验证前端构建产物无错误
   - `bun run build:web 2>&1 | tail -5`
   - 预期: 输出包含 "built in" 且无 error
   - 失败排查: 检查 Task 2 的组件导入和类型