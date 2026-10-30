/**
 * Channel 资源包根入口（`@fenix/resource-channel`）。
 *
 * 刻意为空：本包按面拆分出口——表定义 `@fenix/resource-channel/db`、模块描述符
 * `@fenix/resource-channel/module`、服务端能力 `@fenix/resource-channel/server` 与浏览器面
 * `@fenix/resource-channel/web`。不要从这里转出实现，否则消费方会绕过面边界（`src/server/repositories/`
 * 只供包内使用）。
 */

export {};
