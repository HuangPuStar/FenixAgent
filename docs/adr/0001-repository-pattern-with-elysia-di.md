# Repository Pattern with Elysia DI

将 `store.ts` 拆分为按领域划分的 Repository 模块，通过 Elysia `.decorate()` 全局单例注入。Repository 接口统一为异步，即使底层是内存 Map 也包装为 Promise。Transport 层和 Route 层不直接导入 store 函数，通过 Service 层间接访问 Repository。级联删除（如删除 Environment 时清理 Session）在 Service 层编排，不依赖数据库 CASCADE 也不放在 Repository 内部。

Repository 定义 interface + 实现分离，通过 Elysia `.decorate()` 注入全局单例。测试时在独立 Elysia 实例上 `.decorate()` mock 实现。方法签名保留现有 store 函数名（如 `getEnvironment`、`listSessionsByUserId`），只加 `async`。仓储文件放在 `src/repositories/` 目录。

Status: accepted
