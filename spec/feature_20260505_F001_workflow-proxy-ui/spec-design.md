# Feature: 20260505_F001 - workflow-proxy-ui

## 需求背景

项目已集成 `acpx-g` 工作流引擎（Rust 编写），通过 `restart-acpx-g.sh` 脚本启动，运行在 8848 端口。acpx-g 自带完整的 Web UI（工作流编辑器 + 运行记录），但用户需要登录 RCS 控制面板后才能访问。目前 acpx-g 独立运行在另一个端口，无法与 RCS 统一认证和管理。

需要将 acpx-g 的 UI 嵌入到 RCS 控制面板中，通过反向代理实现统一入口和认证保护。

## 目标

- 在 RCS 后端添加反向代理路由，将请求转发到 acpx-g 服务
- 在 RCS 前端添加 Workflow 页面，通过 iframe 嵌入 acpx-g 的原生 UI
- 所有访问走 sessionAuth 认证，确保未登录用户无法访问
- acpx-g 服务地址可通过环境变量配置

## 方案设计

### 架构概述

采用「双层反向代理 + iframe 嵌入」方案。RCS 后端作为代理网关，将两类请求转发到 acpx-g：

```
浏览器 → RCS 后端 (sessionAuth) → acpx-g (localhost:8848)
  /workflow-ui/*  ─── 代理 ───→  /*        (HTML/CSS/JS 静态资源)
  /api/v1/*       ─── 代理 ───→  /api/v1/*  (工作流 API 调用)
```

### 路径映射设计

acpx-g 前端使用两种路径模式：

| 类型 | acpx-g 原始路径 | 浏览器实际请求 | 代理转发目标 |
|------|----------------|---------------|-------------|
| HTML 页面 | `/` | `/workflow-ui/` | `localhost:8848/` |
| CSS/JS 资源 | `style.css`（相对路径） | `/workflow-ui/style.css` | `localhost:8848/style.css` |
| API 调用 | `/api/v1/workflows`（绝对路径） | `/api/v1/workflows` | `localhost:8848/api/v1/workflows` |

**关键点**：acpx-g HTML 中的静态资源引用为相对路径（`style.css`、`app.js`），iframe 加载 `/workflow-ui/` 时浏览器自动解析为 `/workflow-ui/style.css`。API 调用使用绝对路径（`/api/v1/workflows`），浏览器请求域名根路径，由 `/api/v1/*` 代理路由捕获。RCS 现有路由无 `/api/v1/*` 前缀（只有 `/api/auth/*`），不会冲突。

### 后端路由设计

**新文件**：`src/routes/web/workflow-proxy.ts`

```typescript
// Hono 路由，挂载 sessionAuth 中间件
// 1. /workflow-ui/* → 代理到 acpx-g 的 /*（去 prefix）
// 2. /api/v1/*      → 代理到 acpx-g 的 /api/v1/*（直转）
```

代理实现方式：
- 使用 `fetch()` 将请求转发到 acpx-g
- 流式转发响应（支持大文件和长连接）
- 透传 Content-Type、状态码等响应头
- acpx-g 不可达时返回 502 和友好错误信息

**挂载位置**：`src/index.ts`

```typescript
import workflowProxy from "./routes/web/workflow-proxy";
// 挂在 sessionAuth 之后（workflow-proxy.ts 内部处理认证）
app.route("/web", workflowProxy);
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ACPX_G_URL` | `http://localhost:8848` | acpx-g 服务地址 |

### 前端页面设计

**新文件**：`web/src/pages/WorkflowPage.tsx`

页面结构：
- 顶部标题栏：「工作流」标题 + acpx-g 连接状态指示
- 主体区域：全屏 iframe，src 为 `/workflow-ui/`
- 加载状态：iframe 加载中显示 spinner
- 错误状态：acpx-g 不可达时显示错误提示（iframe onerror）

### 侧边栏导航

在 `Sidebar.tsx` 的「配置」分组中添加：

```typescript
{ id: "workflow", label: "工作流", icon: Workflow }  // lucide-react Workflow 图标
```

### 路由集成

在 `App.tsx` 中：
- `configViews` 数组添加 `"workflow"`
- `ViewId` 类型添加 `"workflow"`
- 添加 `WorkflowPage` lazy import 和条件渲染

## 实现要点

### 代理实现细节

1. **请求转发**：读取原始请求的 method、headers、body，构造新的 Request 发送到 acpx-g
2. **路径重写**：`/workflow-ui/*` 路由需去掉 `/workflow-ui` 前缀后拼接到 acpx-g URL
3. **响应转发**：直接透传 acpx-g 的响应，包括 headers 和 body（流式）
4. **Host header**：转发时修改 Host 为 acpx-g 的地址，避免 CORS 问题
5. **静态文件 MIME 类型**：acpx-g 返回的 Content-Type 直接透传，无需猜测

### 认证策略

- iframe 加载 `/workflow-ui/` 时，浏览器自动携带 RCS 的 session cookie（同域名）
- 代理路由检查 sessionAuth，未认证返回 302 重定向到登录页
- acpx-g 的 API 调用（`/api/v1/*`）同样走 sessionAuth，保证安全性

### acpx-g 服务可用性

- acpx-g 服务由 `restart-acpx-g.sh` 脚本独立管理，RCS 不负责启停
- 代理在 acpx-g 不可达时返回 502 错误码
- 前端 iframe 可通过加载失败检测到服务不可用，显示友好提示

### 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/routes/web/workflow-proxy.ts` | 新建 | 反向代理路由 |
| `src/index.ts` | 修改 | 挂载 workflow-proxy 路由 |
| `web/src/pages/WorkflowPage.tsx` | 新建 | iframe 容器页面 |
| `web/src/components/shell/Sidebar.tsx` | 修改 | 添加工作流导航项 |
| `web/src/App.tsx` | 修改 | 添加 workflow 路由和 lazy import |

## 验收标准

- [ ] 侧边栏出现「工作流」导航项，点击跳转到 workflow 页面
- [ ] workflow 页面通过 iframe 正常显示 acpx-g 的原生 UI
- [ ] 工作流编辑器功能正常（创建、编辑、保存工作流）
- [ ] 运行记录页面正常（查看运行状态、节点日志）
- [ ] 通过模板运行工作流功能正常
- [ ] 未登录用户访问 `/workflow-ui/` 被重定向到登录页
- [ ] acpx-g 服务未启动时，页面显示友好错误提示
- [ ] acpx-g 服务地址可通过 `ACPX_G_URL` 环境变量配置
