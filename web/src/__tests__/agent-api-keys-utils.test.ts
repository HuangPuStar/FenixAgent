import { describe, expect, test } from "bun:test";
import { ApiError } from "../api/request";
import {
  filterApiKeys,
  formatApiKeyDate,
  getApiKeyCreateErrorMessage,
} from "../pages/agent-panel/pages/agent-api-keys-utils";

const messages: Record<string, string> = {
  "toast.createFailed": "创建 API 密钥失败",
  "toast.duplicateName": "创建失败：已存在同名 API 密钥，请更换名称",
};

describe("agent api keys utils", () => {
  // 创建 API key 遇到同名错误时，应展示明确原因，而不是通用失败文案。
  test("maps duplicate name error to specific toast", () => {
    const result = getApiKeyCreateErrorMessage(
      new ApiError("API key name already exists", "DUPLICATE_API_KEY_NAME"),
      (key) => messages[key] ?? key,
    );

    expect(result).toBe("创建失败：已存在同名 API 密钥，请更换名称");
  });

  // 未识别的错误仍应回退到通用失败文案，避免提示缺失。
  test("falls back to generic create failure message", () => {
    const result = getApiKeyCreateErrorMessage(new Error("unknown"), (key) => messages[key] ?? key);

    expect(result).toBe("创建 API 密钥失败");
  });

  // 搜索同时覆盖名称和服务端返回的安全前缀，不接触不可恢复的完整密钥。
  test("filters keys by name or prefix", () => {
    const keys = [
      { id: "1", name: "Production", prefix: "rcs_live", createdAt: "2026-01-01", expiresAt: null, lastUsedAt: null },
      { id: "2", name: "Automation", prefix: "rcs_test", createdAt: "2026-01-01", expiresAt: null, lastUsedAt: null },
    ];

    expect(filterApiKeys(keys, "prod")).toEqual([keys[0]]);
    expect(filterApiKeys(keys, "TEST")).toEqual([keys[1]]);
  });

  // 空日期使用界面提供的语义标签，区分“从未使用”和“永不过期”。
  test("formats missing flexible dates with the supplied label", () => {
    expect(formatApiKeyDate(null, "zh-CN", "永不过期")).toBe("永不过期");
    expect(formatApiKeyDate("invalid", "zh-CN", "—")).toBe("—");
  });
});
