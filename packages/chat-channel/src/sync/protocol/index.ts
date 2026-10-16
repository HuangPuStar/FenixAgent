// packages/chat-channel/src/sync/protocol/index.ts
// 同步协议契约面（身份、帧、错误码）。
// 设计 §4.1 / §8.3：数据协议在本包唯一维护，本目录不得 import 其它 sync 子目录（除 ../clock）。

export * from "./errors";
export * from "./frames";
export * from "./identity";
