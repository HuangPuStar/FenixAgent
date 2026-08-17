// packages/chat-channel/src/server.ts
// 服务端完整入口 = 浏览器安全面（./index）+ channel 控制面 + persist 持久化
// + state 聚合层（DocManager / factory / aggregator 等）。
// 仅服务端消费：Bun 运行时经 package.json exports 的 "./server" 子路径解析，
// tsc 走 tsconfig.base.json 的 paths 映射；前端 vite alias 只指向根入口，
// 永远不应 import 本文件（见根入口头注释与 CLAUDE.md YJS 不变量 11）。
// 与 ./index 的同源 star 导出（chat-writer / yjs-store）指向同一原始 binding，
// ESM 无导出歧义。

export * from "./channel";
export * from "./index";
export * from "./persist";
export * from "./state";
