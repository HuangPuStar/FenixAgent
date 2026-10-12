/**
 * `@fenix/git` 根出口：公共 Git 的稳定契约（类型、错误、客户端接口）。
 *
 * 只导出**类型与契约常量**，不含实现：消费者（工单模块、其他业务）编译期只需要这些声明，运行期实例
 * 由宿主经 `@fenix/git/server` 取得（`GitService.createScopedClient`）。根出口保持零运行时依赖，
 * 避免把 Drizzle、Elysia 或适配器代码拖进消费者的模块图。
 */

export * from "./contracts/client";
export * from "./contracts/errors";
export * from "./contracts/types";
