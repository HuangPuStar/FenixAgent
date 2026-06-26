# 插件层

> 对应文件：`src/plugins/` 目录（`cors.ts`、`logger.ts`、`error-handler.ts`、`auth.ts`、`static.ts`、`system-api-auth.ts`、`require-team-scope.ts`、`rate-limit.ts`）

## 这个模块干什么

插件层处理所有"每个请求都要做的事"——CORS、日志、错误处理、限流、认证、路径归一化、请求体大小限制、静态文件服务、OpenAPI 文档生成。这些是横切关注点，不属于任何具体业务模块，但对所有路由生效。

## 六个 Elysia 插件 + 三个独立模块

### 1. corsPlugin（`cors.ts`）

设置 CORS 策略，允许前端 SPA 跨域访问后端 API。

- 使用 `@elysiajs/cors` 插件
- Origin 从 `RCS_CORS_ORIGIN` 环境变量读取（逗号分隔，默认 `*`）
- Methods：GET、POST、PUT、DELETE、PATCH
- Allowed headers：Content-Type、Authorization
- `credentials: true`（支持 cookie 跨域）

### 2. loggerPlugin（`logger.ts`）——Hook 函数挂载

**注意**：此模块不是 Elysia 插件（不使用 `.use()` 封装），而是通过 `derive` + `onBeforeHandle` / `onAfterHandle` / `onError` 钩子直接挂到主 app 上。

- **`deriveRequestId`** → 挂载到主 app 的 `.derive()`：为每个请求生成 UUID 作为 `requestId`，注入 ALS（AsyncLocalStorage）上下文。后续所有 `logger.info/error` 自动携带 `requestId`，无需手动传参
- **`logRequest`** → 挂载到 `.onBeforeHandle()`：记录请求方法、路径、requestId。高频轮询路径（`/web/config/agents`、`/web/environments`、`/web/environments/*/instances`、`/web/config/models`）降为 debug 级别
- **`logResponse`** → 挂载到 `.onAfterHandle()`：记录响应状态码、耗时。慢请求告警（>1s warn，>5s error）
- **`injectRequestId`** → 挂载到 `.onAfterHandle()`（紧接 logResponse 之后）：向响应注入 `X-Request-Id` 头
- **`logError`** → 挂载到 `.onError()`：记录请求错误详情。Elysia `ValidationError` 特殊处理——压缩为单行（type + path + summary + value 描述）而非完整 JSON

### 3. errorPlugin（`error-handler.ts`）

全局错误捕获。通过 `.onError()` 钩子统一处理三类错误：

- **`AppError` 子类**→ 使用自定义 statusCode 和 code
- **Elysia `ValidationError`**→ 返回 400，首个错误的 path + summary
- **其他异常**→ `code=NOT_FOUND` 时 404，其余 500

返回标准格式 `{ error: { type, message } }`。

### 4. authPlugin（`auth.ts` 中的 `authPlugin` 部分）

挂载 better-auth 原生 HTTP handler 到 `/api/auth/*`。

- 提供 `GET /api/auth/encryption-key`：前端获取 AES 加密公钥
- 提供 `GET /api/auth/signup-status`：注册开关状态
- `all("/*")` 透传给 `auth.handler(request)`，并自动拦截登录/注册/改密 POST 请求解密 AES-GCM 加密的密码字段

### 5. authGuardPlugin（`auth.ts` 中的 `authGuardPlugin` 部分）

提供五种认证 macro，路由声明式选用。详细设计见 [03-auth.md](./03-auth.md)。

通过 Elysia 的 `.macro()` API 实现：

| Macro | 认证方式 | 用途 |
|-------|----------|------|
| `sessionAuth` | better-auth session cookie | 前端用户 Web 路由 |
| `apiKeyAuth` | Bearer token（API Key / Environment Secret） | 外部 API 客户端 |
| `uuidAuth` | URL query 参数 `?uuid=xxx` | 临时匿名访问 |
| `sessionIngressAuth` | Worker JWT（Bearer token） | Session Ingress / Worker 调用 |
| `systemApiKeyAuth` | `systemApiAuthPlugin` 中独立实现 | 系统级管理 API |

认证成功后，用户和组织信息存入 `store.user` 和 `store.authContext`，后续 handler 可以直接使用。

### 6. ctrlStaticPlugin（`static.ts`）

挂载前端构建产物。`/ctrl/*` 路径映射到 `web/dist/` 目录。

- 使用 `@elysiajs/static` 插件
- 自动检测 dist 目录位置（`cwd/web/dist` → `__dirname/../../web/dist` → `cwd/web` 三级 fallback）
- SPA fallback：对 `/ctrl/*` 无扩展名路径的 404，返回 `index.html`（client-side routing）
- 历史重定向：`/ctrl/:sessionId/user/:filePath` → `/web/sessions/:sessionId/user/:filePath?preview=true`

### 7. rateLimitPlugin（`rate-limit.ts`）

全局请求频率限制。通过 `.onBeforeHandle()` 钩子实现：

- **窗口**：1 分钟
- **上限**：100 次请求
- **客户端识别**：`x-forwarded-for` → `x-real-ip` → `"unknown"`
- **测试环境跳过**：`NODE_ENV=test` 或 `Bun.env.BUN_TEST` 时不限流
- **清理**：每 5 分钟清理一次过期计数器

### 8. requireOrgScope（`require-team-scope.ts`）

组织级权限校验工具函数。不是 Elysia 插件，而是独立函数供路由 handler 调用：

```typescript
const denied = requireOrgScope(store.authContext, resourceOrgId);
if (denied) return denied;
```

校验 `authContext.organizationId === resourceOrgId`，不匹配返回 403。所有 organization 级资源路由必须调用此函数。

### 9. systemApiAuthPlugin（`system-api-auth.ts`）

系统级 API Key 认证插件。通过 `.macro()` 提供 `systemApiKeyAuth`：

- 从 Bearer token 或 `?token=xxx` 提取系统 key
- 对比环境变量 `RCS_SYSTEM_API_KEYS`（逗号分隔的 key 列表）
- 不设置用户/组织上下文（与多租户 API 身份模型隔离）
- Key 未配置时接口自动拒绝

## 挂载顺序

插件在 `src/index.ts` 中按以下顺序挂载：

```text
app
  .use(corsPlugin)                        ① CORS 最先，确保预检请求能通过
  .use(openapi(External API docs))        ② 外部 API 文档
  .use(openapi(Web API docs))             ③ 内部 Web API 文档
  .derive(deriveRequestId)                ④ 请求 ID 注入（ALS）
  .onBeforeHandle(logRequest)             ⑤ 请求日志记录
  .onAfterHandle(logResponse)             ⑥ 响应日志记录
  .onAfterHandle(injectRequestId)         ⑦ X-Request-Id 响应头注入
  .onError(logError)                      ⑧ 错误日志记录
  .use(errorPlugin)                       ⑨ 错误处理兜底
  .use(rateLimitPlugin)                   ⑩ 全局限流
  .onBeforeHandle(请求体大小拦截 100MB)    ⑪ Content-Length 413 拦截
  .onBeforeHandle(路径归一化 //)           ⑫ 双斜杠 302 重定向
  .use(authPlugin)                        ⑬ better-auth handler (/api/auth/*)
  .use(ctrlStaticPlugin)                  ⑭ 静态文件 (/ctrl/*)
  .use(v2CodeSessions / sessionIngress / v2Worker / ...)  ⑮ v2 路由
  .use(webApp)                            ⑯ Web 控制面板路由
  .use(agentSitesProxyApp)                ⑰ Agent Sites 前端代理
  .use(apiAgentsRoutes / apiKnowledgeBaseRoutes / ...)    ⑱ 外部 API 路由
  .use(workflowStaticApp)                 ⑲ Workflow 前端代理
  .use(knowledgeMcpRoutes)                ⑳ MCP 知识库路由
  .use(acpRoutes)                         ㉑ ACP 协议路由
```

### 关键顺序说明

- **CORS 必须在业务路由前面**，否则 OPTIONS 预检请求会被业务路由拦截
- **日志钩子紧接 CORS 后**，确保所有请求都被记录到
- **错误处理（errorPlugin）在日志之后**，确保错误在 hook 函数被正确处理过再 fallback
- **限流在认证之前**，避免未授权请求绕过限流
- **请求体拦截在限流之后、auth 之前**，尽早拒绝超大请求
- **路径归一化在 auth 之前**，避免认证逻辑处理无效路径
- **authPlugin 在静态文件之后**，确保 `/ctrl/*` 静态资源可无认证访问
- **业务路由最后**，确保插件层完全就绪

## OpenAPI 文档

`src/index.ts` 挂载了两个 `@elysiajs/openapi` 插件，通过 tag 互斥：

- **External API**：`/docs/openapi/external`（Scalar UI），面向外部系统的 API 文档
- **Web API**：`/docs/openapi/web`（Scalar UI），控制台内部及平台接口文档

两者共享排除路径（`/health`、openapi 自身路径），通过 tag 过滤实现内容分离。使用 `z.toJSONSchema` 做 Zod → JSON Schema 转换。

## 和其他模块的关系

- `auth.ts` → `src/auth/better-auth.ts`（better-auth 实例）
- `auth.ts` → `src/auth/encryption.ts`（AES 密码解密）
- `auth.ts` → `src/auth/jwt.ts`（Worker JWT 校验）
- `auth.ts` → `src/repositories/environment.ts`（environment secret 匹配）
- `auth.ts` → `src/services/org-context.ts`（组织上下文加载）
- `static.ts` → `web/dist/`（前端构建产物）
- ← `src/index.ts`：挂载所有插件
- ← 所有路由：通过 `authGuardPlugin` 的 macro 声明认证方式，`requireOrgScope` 校验组织权限
