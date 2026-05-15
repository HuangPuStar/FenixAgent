# Eden Treaty as Sole API Client

前端消除 `apiFetch` 手动包装函数，所有 API 调用统一通过 Eden Treaty 客户端。对于后端 POST 路由尚未注册 body schema 的情况，前端手动定义请求类型。FormData 上传不在本次重构范围内，后续单独设计替代方案。

Status: accepted
