# Custom Error Classes with Elysia onError

路由层的业务逻辑提取到 Service 层。Service 抛出自定义错误类（`ValidationError`、`NotFoundError`、`ConflictError` 等），路由通过 Elysia 全局 `onError` handler 统一转换为 HTTP 响应。路由处理器只写 happy path。

Status: accepted
