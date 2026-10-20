// packages/chat-channel/src/sync/index.ts
// 聊天同步协议（设计 2026-10-16-fenix-message-sync-design）的服务端模块面。
//
// 阶段边界（尚未接线到线上路径：relay / gateway / broadcaster / doc-manager / 前端投影均为独立阶段）：
//   A 契约与骨架：protocol（身份/帧/错误码）、capacity（预算与准入）、store/types。
//   B 持久化写者：store/memory-store 保留 fencing、幂等、原子提交与「只读已提交边界」语义；真实持久化
//     adapter（PostgreSQL）未实施，属用户裁定后的后续阶段。
//   C 历史导入：spool/ingest/block-builder/build-pool/committer/import-service。
//   D 实时写入：live（合并缓冲与语义屏障、运行态/控制 Doc 轮换、active → sealed 协议机、单写者编排）。
//   E 同步 provider：provider（握手/订阅/base/tail 状态机、四类额度与公平、ACK 账本）。
//   F 客户端调度：client（有界接收队列与唯一 apply 入口）——浏览器安全面，经 ./sync-client 子路径导出。
//
// 本目录只从 "./server" 暴露：根入口（./index）必须保持浏览器安全，而 spool 依赖 node:fs。
// 帧协议开放给浏览器时只提升无 node 依赖的子集（client），不得整体提升到根入口。

export * from "./capacity";
export * from "./clock";
export * from "./history";
export * from "./live";
export * from "./protocol";
export * from "./provider";
export * from "./runtime";
export * from "./store";
