import { describe, expect, test } from "bun:test";
import { buildSystemUserIdentifier } from "../api/system-people-tree";

describe("system people user identifier", () => {
  // 手机号操作只应发送 phoneNumber，避免后端收到两个互斥标识。
  test("builds a phone identifier", () => {
    expect(buildSystemUserIdentifier("phone", " +86 138 0013 8000 ")).toEqual({
      phoneNumber: "+86 138 0013 8000",
    });
  });

  // 邮箱操作只应发送 email，保持系统 API 的互斥标识契约。
  test("builds an email identifier", () => {
    expect(buildSystemUserIdentifier("email", " user@example.com ")).toEqual({
      email: "user@example.com",
    });
  });
});
