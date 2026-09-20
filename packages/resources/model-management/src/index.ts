/**
 * Model-management 的资源包根入口，**刻意为空**。
 *
 * 计划 §2.3 的 exports 注记：根入口不得（直接或间接）转出浏览器代码，否则服务端侧任何一次
 * `import "@fenix/model-management"` 都会把 React 页面图拖进服务端模块图。浏览器能力因此全部落在
 * `./web`（`web/index.ts`，唯一公开面），服务端能力落在 `./server`（`src/server.ts`），本文件只保留
 * 「包有根入口且浏览器安全」这一形状（与黄金样本 `packages/resources/sandbox/src/index.ts` 一致）。
 */

export {};
