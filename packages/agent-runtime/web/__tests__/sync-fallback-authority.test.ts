// 同步终态错误的权威回退：任何不可恢复错误都必须撤销失效投影的覆盖资格（B09）。

import { describe, expect, test } from "bun:test";
import { shouldFallbackToLegacy } from "../hooks/use-sync-chat-state";
import { INITIAL_SYNC_CHAT_STATE } from "../yjs/sync-chat-state";

function errorState(code: string) {
  return { ...INITIAL_SYNC_CHAT_STATE, status: "error" as const, error: { code, message: "failed" } };
}

describe("同步终态回退", () => {
  // 1009/1011 等内部终态错误同样必须交回旧通道，否则旧通道的新回复会被失效投影继续压制。
  test("内部终态错误回退旧权威", () => {
    expect(shouldFallbackToLegacy(errorState("WS_1009"))).toBe(true);
    expect(shouldFallbackToLegacy(errorState("WS_1011"))).toBe(true);
    expect(shouldFallbackToLegacy(errorState("DOC_NOT_FOUND"))).toBe(true);
  });

  // 协议不可用与正常连接不改变回退判定，避免把可重连状态误判为终态。
  test("协议不可用回退，非终态不回退", () => {
    expect(shouldFallbackToLegacy(errorState("PROTOCOL_VERSION_UNSUPPORTED"))).toBe(true);
    expect(shouldFallbackToLegacy({ ...INITIAL_SYNC_CHAT_STATE, status: "connected" })).toBe(false);
    expect(shouldFallbackToLegacy({ ...INITIAL_SYNC_CHAT_STATE, status: "reconnecting" })).toBe(false);
  });
});
