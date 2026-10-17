// packages/chat-channel/src/sync/runtime/index.ts
// G 阶段装配面（规格 §2.1–§2.4）：配置、实时入口、出帧网关与 scope 级编排。
//
// 只从 "./server" 暴露：本目录在依赖链最上层，经 history/spool 触达 `node:fs`，不得进浏览器安全的根入口。

export * from "./config";
export * from "./egress";
export * from "./ingress";
export * from "./scope-runtime";
