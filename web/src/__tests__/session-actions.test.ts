import { describe, expect, test } from "bun:test";
import { canDeleteSession } from "../../components/chat/session-actions";

describe("canDeleteSession", () => {
  // 当前会话必须禁止删除，避免活动会话状态指向已删除记录。
  test("returns false for the active session", () => {
    expect(canDeleteSession("session-1", "session-1")).toBe(false);
  });

  // 非当前会话仍然可以删除，保持已有删除能力。
  test("returns true for an inactive session", () => {
    expect(canDeleteSession("session-2", "session-1")).toBe(true);
    expect(canDeleteSession("session-2", null)).toBe(true);
  });
});
