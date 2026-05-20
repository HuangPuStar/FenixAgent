import { describe, test, expect } from "bun:test";
import { shouldInterceptOutbound, shouldInterceptInbound, filterConnectFromFlush } from "../transport/relay/message-router";

describe("RelayMessageRouter", () => {
  // keep_alive 消息应被拦截
  test("shouldInterceptOutbound returns true for keep_alive", () => {
    expect(shouldInterceptOutbound({ type: "keep_alive" })).toBe(true);
    expect(shouldInterceptOutbound({ type: "user", content: "hello" })).toBe(false);
  });

  // keep_alive 入站消息应被拦截
  test("shouldInterceptInbound returns true for keep_alive", () => {
    expect(shouldInterceptInbound({ type: "keep_alive" })).toBe(true);
    expect(shouldInterceptInbound({ type: "assistant", content: "hi" })).toBe(false);
  });

  // filterConnectFromFlush 跳过 connect 消息
  test("filterConnectFromFlush skips connect messages", () => {
    const msgs = [
      { type: "connect" },
      { type: "user", content: "hi" },
      { type: "connect" },
      { type: "user", content: "bye" },
    ];
    const filtered = filterConnectFromFlush(msgs);
    expect(filtered.length).toBe(2);
    expect(filtered[0].type).toBe("user");
    expect(filtered[1].type).toBe("user");
  });

  // filterConnectFromFlush 空数组返回空
  test("filterConnectFromFlush handles empty array", () => {
    expect(filterConnectFromFlush([])).toHaveLength(0);
  });

  // filterConnectFromFlush 无 connect 消息时原样返回
  test("filterConnectFromFlush returns all when no connect messages", () => {
    const msgs = [{ type: "user" }, { type: "assistant" }];
    expect(filterConnectFromFlush(msgs)).toHaveLength(2);
  });
});
