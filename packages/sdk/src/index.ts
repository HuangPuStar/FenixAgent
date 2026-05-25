// @mothership/sdk — 类型安全 REST API 客户端

// 基础类
export { BaseApi } from "./base";
// 模块类
export * from "./modules";
// Result 类型
export type { ApiErr, ApiError, ApiOk, ApiResult } from "./result";
export { err, ok } from "./result";
// 从后端 schema 重导出的类型
export type * from "./types/schemas";
