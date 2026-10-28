/**
 * CloudDrive 资源包根入口。
 *
 * 本包的消费方只应使用 `@fenix/resource-cloud-drive/module`（manifest）与
 * `@fenix/resource-cloud-drive/server`（路由工厂、Facade 与出站 client）。根入口刻意不导出任何
 * 运行期值：`apps/generated/module-registry.ts` 会在装配期静态导入 manifest，任何从根入口拖进
 * Elysia/pino 的再导出都会让模块图变重。
 */
export {};
