import { describe, expect, test } from "bun:test";
import { createLogger, error, interceptConsole, log, requestAls, warn } from "../index";

describe("logger 公共入口与异步边界", () => {
  // 所有公开日志方法及兼容函数都能在请求上下文中安全接收诊断参数。
  test("公共日志方法接受上下文和混合参数", () => {
    const logger = createLogger("public-methods");

    requestAls.run({ requestId: "req-public" }, () => {
      expect(() => logger.info("created", { taskId: "task-1" })).not.toThrow();
      expect(() => logger.warn("retry", 2)).not.toThrow();
      expect(() => logger.error(new Error("failed"))).not.toThrow();
      expect(() => logger.debug("details", false)).not.toThrow();
      expect(() => logger.log("legacy entry")).not.toThrow();
      expect(() => log("default entry")).not.toThrow();
      expect(() => warn("default warning")).not.toThrow();
      expect(() => error("default error")).not.toThrow();
    });
  });

  // 定时器异步边界会保留 ALS 请求上下文，且作用域结束后不会泄漏。
  test("定时器异步边界传播并清理请求上下文", async () => {
    const logger = createLogger("async-boundary");
    const entry = await requestAls.run({ requestId: "req-timeout", username: "ada" }, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return logger.formatEntry("info", "after timeout");
    });

    expect(entry).toMatchObject({ requestId: "req-timeout", username: "ada" });
    expect(logger.formatEntry("info", "outside").requestId).toBeUndefined();
  });

  // console 拦截会替换三个入口，并在测试环境静默处理调用。
  test("console 拦截替换并静默处理日志入口", () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    try {
      interceptConsole();

      expect(console.log).not.toBe(originalLog);
      expect(console.warn).not.toBe(originalWarn);
      expect(console.error).not.toBe(originalError);
      expect(() => console.log("console log")).not.toThrow();
      expect(() => console.warn("console warn")).not.toThrow();
      expect(() => console.error("console error")).not.toThrow();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  });
});
