// packages/chat-channel/src/transport/ws-close-codes.ts
// 前端侧「服务端关闭码 → 前端行为」的单一知识表：终态判定与 UI 语义的唯一来源。
//
// 为什么要有这张表：同一份知识此前被写在两处，且已经实际漂移——
// - 传输层 `src/transport/ws.ts` 的 `NO_RECONNECT_CODES`（停不停自动重连）；
// - UI 语义层 `packages/agent-runtime/web/yjs/yjs-ws.ts` 的 `getTerminalYjsWsErrorCode`（给 UI 什么错误码）。
// 两处的码集合并不一致：4503 只在传输层，1013 只在 UI 语义层。
//
// 「是否停重连」与「UI 拿到什么语义」是两个不同的问题，成员集合可以不同，因此本表
// **逐码登记两列**，不做单一集合的硬合并；两个消费方各自派生自己需要的视图：
// - 传输层：`stopReconnect === true` 的码 → 停自动重连；
// - UI 层：`uiCode`（命中 `nonTerminalReason` 时按非终态处理）。
//
// 落点约束：本模块位于根入口可达面（浏览器侧经 `export * from "./transport"` 进入），
// 只允许依赖浏览器可用能力——当前仅 acp-link 的协议常量（白名单见
// `src/__tests__/chat-channel-browser-surface.test.ts`）。

import { WEBSOCKET_CODES } from "acp-link/websocket-code";

/** UI 语义错误码（即服务端关闭原因词表；apps/web 的连接错误态消费同一批字面量）。 */
export type TerminalWsUiCode =
  | "instance_idle_reclaimed"
  | "environment_unavailable"
  | "machine_unavailable"
  | "client_keepalive_timeout"
  | "spawn_rejected"
  | "too_many_connections";

export interface WsCloseCodePolicyEntry {
  code: number;
  /** 传输层是否停自动重连（退避重连与短连接计数之外的额外终态判定）。 */
  stopReconnect: boolean;
  /** 展示给 UI 的语义错误码；null = 该码停重连但当前没有 UI 语义（已知缺口）。 */
  uiCode: TerminalWsUiCode | null;
  /** 携带该关闭原因时本轮不是终态（未携带该原因则按 uiCode 处理）。 */
  nonTerminalReason?: string;
}

/**
 * 慢消费者追赶超时的关闭原因（1013，broadcaster SP-A7）。这串文本是**线上协议的一部分**：
 * 生产方 `channel/broadcaster.ts` 以它作为 `close(1013, ...)` 的 reason 发出，消费方
 * `getTerminalYjsWsErrorCode` 拿收到的 reason 与策略表逐字比较——发送方与判定方必须
 * 引用同一常量，不得各自另立字面量（比对是逐字的，任何一侧改写都会静默失效）。
 */
export const SLOW_CONSUMER_RESYNC_TIMEOUT_REASON = "slow consumer resync timeout";

/**
 * 关闭码策略表。**改这张表会同时改变传输层与 UI 两层行为**，两处基线测试必须一起过：
 * `src/__tests__/ws-close-codes.test.ts`（两个派生视图 vs 改前字面量）与
 * `packages/agent-runtime/web/__tests__/yjs-ws.test.ts`（`getTerminalYjsWsErrorCode` 逐码结果）。
 */
export const WS_CLOSE_CODE_POLICY: readonly WsCloseCodePolicyEntry[] = [
  {
    code: WEBSOCKET_CODES.INSTANCE_RECLAIMED.code,
    stopReconnect: true,
    uiCode: "instance_idle_reclaimed",
  },
  {
    code: WEBSOCKET_CODES.INVALID_REFERENCE.code,
    stopReconnect: true,
    uiCode: "environment_unavailable",
  },
  {
    code: WEBSOCKET_CODES.MACHINE_UNAVAILABLE.code,
    stopReconnect: true,
    uiCode: "machine_unavailable",
  },
  {
    code: WEBSOCKET_CODES.KEEPALIVE_TIMEOUT.code,
    stopReconnect: true,
    uiCode: "client_keepalive_timeout",
  },
  {
    code: WEBSOCKET_CODES.SPAWN_REJECTED.code,
    stopReconnect: true,
    uiCode: "spawn_rejected",
  },
  // 4503：服务端已明确不可恢复（同 machine 已有连接），传输层停重连；`uiCode` 为空是
  // **已知缺口**而非设计决定（docs/developer/guide/frontend-development.md §8.3 / §8.6）。
  // 补齐它会让原先「连接停了但用户没有任何提示」的场景出现新的错误提示 = 行为变化，
  // 必须单独一批处理，本批只做收敛、不补语义。
  {
    code: WEBSOCKET_CODES.MACHINE_ALREADY_CONNECTED.code,
    stopReconnect: true,
    uiCode: null,
  },
  // 1013（标准 WS 容量关闭码，不属于 acp-link 的业务码表）：两个语义来源共用同一个码，
  // 由关闭原因区分——容量拒绝（gateway 连接数超限）是终态；慢消费者追赶超时
  // （broadcaster SP-A7）是非终态，客户端自动重连后走全量快照同步恢复。
  // 两列取值不同正是「两个问题」的体现：传输层不据此停重连（现状靠退避与短连接计数收敛），
  // 不要为了对称把它改成 true（那是行为变化）。
  {
    code: 1013,
    stopReconnect: false,
    uiCode: "too_many_connections",
    nonTerminalReason: SLOW_CONSUMER_RESYNC_TIMEOUT_REASON,
  },
];
