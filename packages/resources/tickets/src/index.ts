/**
 * `@fenix/resource-tickets` 的包根出口（`package.json` 的 `exports["."]`）。
 *
 * 刻意留空：本包的交付面分两侧——服务端走 `./server`（组合根、路由工厂与 Facade），浏览器面走 `./web`
 * 及其子路径（`./web/contribution`、`./web/i18n`）。包根若转出任一侧的实现，`@fenix/resource-tickets`
 * 这一条 import 就会把 Drizzle、Elysia 或 React 拖进消费者的模块图；装配面只经 `./module` 惰性取
 * manifest（`create` 与路由贡献都是 `import()`）。同款先例：`@fenix/resource-mcp`、`@fenix/resource-task`
 * 的包根同样是 `export {}`。
 */

export {};
