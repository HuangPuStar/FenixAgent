// src/__tests__/ws-close-codes.test.ts
// 关闭码策略表的基线锁。
//
// 该表是传输层（停不停自动重连）与 UI 语义层（给 UI 什么错误码）的唯一来源，改表即同时
// 改两层行为，因此这里把**改前的字面量**固定成基线：任何新增/删除/改语义都必须显式改
// 这份基线，并同步 `packages/agent-runtime/web/__tests__/yjs-ws.test.ts` 的逐码断言。
// 本测试只断言派生视图，不重复断言调用点行为（调用点行为见 ws.test.ts 与 yjs-ws.test.ts）。

import { describe, expect, test } from "bun:test";
import { WS_CLOSE_CODE_POLICY } from "../transport/ws-close-codes";

/** 基线：收敛前 `transport/ws.ts` 的 `NO_RECONNECT_CODES` 字面量。 */
const BASELINE_NO_RECONNECT_CODES = [4001, 4004, 4500, 4501, 4502, 4503];

/** 基线：收敛前 `agent-runtime/web/yjs/yjs-ws.ts` 的 code → UI 语义字面量（null = 无 UI 语义）。 */
const BASELINE_UI_CODES = new Map<number, string | null>([
  [4001, "instance_idle_reclaimed"],
  [4004, "environment_unavailable"],
  [4500, "machine_unavailable"],
  [4501, "client_keepalive_timeout"],
  [4502, "spawn_rejected"],
  // 4503：停重连但无 UI 语义——已知缺口，见 docs/developer/guide/frontend-development.md §8.3/§8.6
  [4503, null],
  [1013, "too_many_connections"],
]);

describe("关闭码策略表", () => {
  test("传输层视图（停自动重连的码集合）与改前逐字一致", () => {
    const codes = WS_CLOSE_CODE_POLICY.filter((entry) => entry.stopReconnect).map((entry) => entry.code);
    expect(codes).toEqual(BASELINE_NO_RECONNECT_CODES);
  });

  test("UI 语义视图与改前逐字一致", () => {
    const uiCodes = new Map(WS_CLOSE_CODE_POLICY.map((entry) => [entry.code, entry.uiCode] as const));
    expect(uiCodes).toEqual(BASELINE_UI_CODES);
  });

  test("码不重复（重复码会让 find 命中前者、静默遮蔽后者）", () => {
    const codes = WS_CLOSE_CODE_POLICY.map((entry) => entry.code);
    expect(codes.length).toBe(new Set(codes).size);
  });
});
