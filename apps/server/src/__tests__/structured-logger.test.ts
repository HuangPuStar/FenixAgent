import { describe, expect, test } from "bun:test";
import { createLogger } from "@fenix/logger";
import { sanitizeErrorForLog } from "../plugins/logger";

// 结构化日志：输出格式包含 level、module、message 字段
describe("structured logger", () => {
  test("log() 输出 info 级别的结构化日志", () => {
    const logger = createLogger("test-module");
    const entry = logger.formatEntry("info", "hello", { requestId: "req-1" });
    expect(entry.level).toBe("info");
    expect(entry.module).toBe("test-module");
    expect(entry.message).toBe("hello");
    expect(entry.requestId).toBe("req-1");
  });

  test("error() 输出 error 级别", () => {
    const logger = createLogger("test-module");
    const entry = logger.formatEntry("error", "something failed");
    expect(entry.level).toBe("error");
  });

  test("不设置 requestId 时字段为 undefined", () => {
    const logger = createLogger("mod");
    const entry = logger.formatEntry("info", "no-request");
    expect(entry.requestId).toBeUndefined();
  });

  test("formatEntry 包含 timestamp", () => {
    const logger = createLogger("mod");
    const entry = logger.formatEntry("info", "test");
    expect(entry.timestamp).toBeDefined();
    expect(typeof entry.timestamp).toBe("string");
  });

  // HTTP 错误日志必须移除数据库 query/params 及嵌套 cause，避免配置密钥进入日志。
  test("HTTP 错误日志会脱敏数据库错误详情", () => {
    const error = Object.assign(new Error("Failed query: insert into mcp_server params: secret-token"), {
      name: "DrizzleQueryError",
      query: "insert into mcp_server values ($1)",
      params: ["secret-token"],
      cause: new Error("Authorization: Bearer secret-token"),
    });

    const sanitized = sanitizeErrorForLog(error);
    expect(sanitized.name).toBe("DrizzleQueryError");
    expect(sanitized.message).toBe("Database operation failed");
    expect("query" in sanitized).toBe(false);
    expect("params" in sanitized).toBe(false);
    expect("cause" in sanitized).toBe(false);
  });
});
