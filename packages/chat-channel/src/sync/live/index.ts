// packages/chat-channel/src/sync/live/index.ts
// 实时写入（设计 §6、§7）：写入前合并与语义屏障、运行态/控制 Doc 轮换、active → sealed 协议机、单写者编排。

export * from "./change-capture";
export * from "./live-writer";
export * from "./merge-buffer";
export * from "./rotation";
export * from "./runtime-doc";
export * from "./sealing";
