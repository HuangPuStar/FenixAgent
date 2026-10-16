// packages/chat-channel/src/sync/store/index.ts
// 投影存储（设计 §9）：接口 + 内存 adapter。
// PostgreSQL adapter 未实施：按用户裁定，本阶段只落内存结构；接线时必须新增具备真实事务与
// fencing 的 adapter，并替换 memory-store 的崩溃恢复占位（见 memory-store.ts 的说明）。

export * from "./memory-store";
export * from "./types";
