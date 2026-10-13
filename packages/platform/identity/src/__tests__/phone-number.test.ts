import { describe, expect, test } from "bun:test";
import { buildPhoneTempEmail, normalizeChineseMainlandPhoneNumber } from "../services/phone-number";

describe("phone-number helpers", () => {
  // 应将带国家码和分隔符的手机号归一化为 11 位大陆手机号。
  test("normalizes mainland phone numbers", () => {
    expect(normalizeChineseMainlandPhoneNumber("+86 188-2648-0215")).toBe("18826480215");
  });

  // 应拒绝非大陆手机号格式，避免 12 位等脏数据进入系统。
  test("rejects invalid mainland phone numbers", () => {
    expect(() => normalizeChineseMainlandPhoneNumber("188264802150")).toThrow("手机号格式不正确");
  });

  // 应基于归一化手机号生成兼容 better-auth 的临时邮箱。
  test("builds temporary email from normalized phone number", () => {
    expect(buildPhoneTempEmail("18826480215")).toBe("18826480215@fenix.com");
  });
});
