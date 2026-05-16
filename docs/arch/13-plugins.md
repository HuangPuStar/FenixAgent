# 插件层

> 对应文件：`src/plugins/`

## 这个模块干什么

插件层处理所有"每个请求都要做的事"——CORS、日志、错误处理、认证、静态文件服务。这些是横切关注点，不属于任何具体业务模块，但对所有路由生效。

## 六个插件

### corsPlugin（`cors.ts`）

设置 CORS 策略，允许前端 SPA 跨域访问后端 API。

### loggerPlugin（`logger.ts`）

请求级别的日志记录。记录每个 HTTP 请求的方法、路径、响应状态码和耗时。

### errorPlugin（`error-handler.ts`）

全局错误捕获。当路由 handler 或 Service 层抛出未处理的异常时，这个插件统一捕获，返回标准格式的错误响应，防止服务崩溃。

### authPlugin（`auth.ts`中的 `authPlugin` 部分）

挂载 better-auth 的原生 HTTP handler 到 `/api/auth/*`。这个路径下的请求（登录、注册、session 校验等）直接交给 better-auth 库处理，不经过路由层。

### authGuardPlugin（`auth.ts`中的 `authGuardPlugin` 部分）

提供四种认证 macro，路由声明式选用。详细设计见 [03-auth.md](./03-auth.md)。

它通过 Elysia 的 `.macro()` API 实现——路由写 `{ sessionAuth: true }`，框架自动在请求处理前执行认证逻辑。认证成功后，用户信息存入 `store.user`，后续 handler 可以直接使用。

### ctrlStaticPlugin（`static.ts`）

挂载前端构建产物。`/ctrl/*` 路径映射到 `web/dist/` 目录。前端是 React SPA，所有未匹配的路径都返回 `index.html`（client-side routing）。

### repoPlugin（`repositories.ts`）

把仓储实例注入 Elysia context。路由 handler 可以通过 `store` 访问 `environmentRepo`、`sessionRepo` 等。

## 挂载顺序

插件在 `index.ts` 中按以下顺序挂载：

```text
app
  .use(corsPlugin)        ① CORS 最先，确保预检请求能通过
  .use(loggerPlugin)      ② 日志第二，记录所有请求
  .use(errorPlugin)       ③ 错误处理第三，兜底所有异常
  .use(repoPlugin)        ④ 仓储注入，让后续路由能用
  .use(authPlugin)        ⑤ better-auth handler
  .use(ctrlStaticPlugin)  ⑥ 静态文件
  .use(v1Routes)          ⑦ 业务路由
  .use(webRoutes)         ...
  .use(acpRoutes)
```

顺序很重要：CORS 和日志必须在业务路由前面，否则 OPTIONS 预检请求会被业务路由拦截。

## 和其他模块的关系

- `auth.ts` → `auth/better-auth.ts`（better-auth 实例）
- `auth.ts` → `auth/api-key-service.ts`（API Key 校验）
- `auth.ts` → `auth/jwt.ts`（JWT 校验）
- `auth.ts` → `repositories/environment.ts`（environment secret 匹配）
- `repositories.ts` → `repositories/*`（仓储实例）
- `static.ts` → `web/dist/`（前端构建产物）
- ← `index.ts`：挂载所有插件
- ← 所有路由：通过 plugin 注入的 context 访问认证信息和仓储
