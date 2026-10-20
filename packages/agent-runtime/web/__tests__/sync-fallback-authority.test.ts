// 同步终态错误的权威回退：任何不可恢复错误都必须撤销失效投影的覆盖资格（B09）。

import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { shouldBlockPromptOnIncompleteLegacy } from "../agent-panel/sync-authority";
import { createSyncMessageMerger } from "../hooks/sync-chat-messages";
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

  // 回退后新投影为空，旧通道新增的问题与回复必须原样可见，不能被失效投影压制（B09）。
  test("回退后旧通道的新问答可见", () => {
    const legacy: StructuredMessage[] = [
      { type: "user_message", id: "u1", content: "旧问题", ts: 1, seq: 0 },
      { type: "assistant_message", id: "a1", chunks: [{ type: "message", text: "旧回复" }], ts: 2, seq: 1 },
      { type: "user_message", id: "u2", content: "新问题", ts: 3, seq: 2 },
      { type: "assistant_message", id: "a2", chunks: [{ type: "message", text: "新回复" }], ts: 4, seq: 3 },
    ];
    expect(createSyncMessageMerger()(legacy, []).map((message) => message.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  // 旧通道历史不完整时阻止发送；完整时允许继续用旧通道，只保留诊断（B09）。
  test("旧通道不完整时阻止发送", () => {
    expect(shouldBlockPromptOnIncompleteLegacy({ legacyFallback: true, historyIncomplete: true })).toBe(true);
    expect(shouldBlockPromptOnIncompleteLegacy({ legacyFallback: true, historyIncomplete: false })).toBe(false);
    expect(shouldBlockPromptOnIncompleteLegacy({ legacyFallback: false, historyIncomplete: true })).toBe(false);
  });
});
