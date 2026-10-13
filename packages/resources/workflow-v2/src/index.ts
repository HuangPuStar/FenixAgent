/**
 * Workflow V2 资源包的浏览器安全入口（`package.json` 的 `exports["."]`）。
 *
 * 与 `@fenix/resource-workflow` 同形：浏览器面走 `./web`，服务端面走 `./server`，组合根走 `./module`，
 * 三种消费方各有自己的出口。本文件不转出任何服务端代码——`exports["."]` 会被宿主与工具链当成通用入口，
 * 在这里透出 Elysia / Drizzle 等于把服务端图挂到浏览器可达的路径上。
 */

export {};
