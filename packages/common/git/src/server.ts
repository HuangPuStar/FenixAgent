/**
 * `@fenix/git/server`：公共 Git 的服务端出口。
 *
 * 消费者只有宿主（`apps/server`）与实验性的工单模块：宿主用它投影并创建模块、读取错误码；业务包用
 * `GitService.createScopedClient` 取得受控作用域。这里同时镜像契约类型与配置类型——宿主在 `module-configs`
 * 里投影 `GitModuleConfig` 时需要它们，走根出口会多一次包边界解析。
 *
 * 刻意**不**出口的东西：适配器（`ForgejoClient`）、仓储与绑定服务工厂。它们只能在包内被组合根使用，
 * 一旦外露就会有人绕过绑定记录直接构造带 provision token 的客户端，作用域与授权也就随之失效。
 */

export type * from "./contracts/client";
export { GitError, isGitError } from "./contracts/errors";
export type * from "./contracts/types";
export { createGitModule, disposeGitModule, getGitService, resetGitModuleForTesting } from "./module";
export type { GitConnectionConfig, GitModuleConfig } from "./server/config";
export { GitModuleConfigSchema, parseGitModuleConfig } from "./server/config";
