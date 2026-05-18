import { describe, expect, test } from "bun:test";
import { createLogger, type StructuredLogEntry } from "../logger";

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
});
