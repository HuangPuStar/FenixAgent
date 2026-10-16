// packages/chat-channel/src/sync/index.ts
// 聊天同步协议（设计 2026-10-16-fenix-message-sync-design）的服务端模块面。
//
// 阶段边界（本目录当前只覆盖 A/B/C，尚未接线到线上路径）：
//   A 契约与骨架：protocol（身份/帧/错误码）、capacity（预算与准入）、store/types。
//   B 持久化写者：store/memory-store 保留 fencing、幂等、原子提交与「只读已提交边界」语义；真实持久化
//     adapter（PostgreSQL）未实施，属用户裁定后的后续阶段。
//   C 历史导入：spool/ingest/block-builder/build-pool/committer/import-service。
// 客户端应用调度（设计 §8.6）与 provider 接线（§8.2–§8.5）不在本目录，尚未实现。
//
// 本目录只从 "./server" 暴露：根入口（./index）必须保持浏览器安全，而 spool 依赖 node:fs，
// 接线阶段若要把帧协议开放给浏览器，应单独拆出无 node 依赖的子集，不得整体提升到根入口。

export * from "./capacity";
export * from "./clock";
export * from "./history";
export * from "./protocol";
export * from "./store";
