// packages/chat-channel/src/sync/client/index.ts
// 客户端同步面（设计 §8.6）：有界接收队列与唯一 apply 入口 DocHub，以及绑定帧层与它的传输适配（规格 §2.5）。
//
// 浏览器安全：本目录及其值导入闭包不得触碰 node 内建、fs、process、Buffer，因此只经
// `@fenix/chat-channel/sync-client` 子路径导出，不进根入口 ./index（那里允许浏览器消费）与 ./server（依赖 node）。
// 由 `sync-client-browser-surface.test.ts` 静态守护该边界。

export * from "./apply-queue";
export * from "./doc-hub";
export * from "./transport";
