import { describe, expect, test } from "bun:test";
import { createLogger, requestAls } from "../index";

function expectEntry(
  entry: ReturnType<ReturnType<typeof createLogger>["formatEntry"]>,
  expected: Record<string, unknown>,
): void {
  expect(entry).toMatchObject(expected);
  expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
}

describe("logger 内存结构化行为", () => {
  // 基础 info 条目保留模块、级别与文本消息。
  test("格式化 info 条目", () => {
    const logger = createLogger("billing");
    expectEntry(logger.formatEntry("info", "created"), { level: "info", module: "billing", message: "created" });
  });

  // warn 条目不会被错误映射为其他日志级别。
  test("格式化 warn 条目", () => {
    const logger = createLogger("billing");
    expectEntry(logger.formatEntry("warn", "retry"), { level: "warn", module: "billing", message: "retry" });
  });

  // error 条目保留诊断消息而不丢失模块归属。
  test("格式化 error 条目", () => {
    const logger = createLogger("billing");
    expectEntry(logger.formatEntry("error", "failed"), { level: "error", module: "billing", message: "failed" });
  });

  // debug 条目可用于低优先级诊断。
  test("格式化 debug 条目", () => {
    const logger = createLogger("billing");
    expectEntry(logger.formatEntry("debug", "details"), { level: "debug", module: "billing", message: "details" });
  });

  // 额外字段会完整合并到结构化条目。
  test("合并额外字段", () => {
    const logger = createLogger("worker");
    expectEntry(logger.formatEntry("info", "queued", { jobId: "job-1", attempt: 2 }), {
      jobId: "job-1",
      attempt: 2,
    });
  });

  // 额外字段可覆盖同名的非安全展示字段，保持调用方 pino 语义一致。
  test("额外字段按对象展开顺序覆盖展示字段", () => {
    const logger = createLogger("worker");
    expectEntry(logger.formatEntry("info", "original", { message: "override" }), { message: "override" });
  });

  // 没有请求上下文时不伪造 requestId。
  test("无上下文时省略请求字段", () => {
    const logger = createLogger("cron");
    const entry = logger.formatEntry("info", "tick");
    expect(entry.requestId).toBeUndefined();
    expect(entry.organizationId).toBeUndefined();
  });

  // 请求上下文会注入全部已提供的租户诊断字段。
  test("注入完整请求上下文", () => {
    const logger = createLogger("api");
    const entry = requestAls.run(
      { requestId: "req-1", userId: "user-1", username: "ada", organizationId: "org-1", organizationName: "Alpha" },
      () => logger.formatEntry("info", "handled"),
    );
    expectEntry(entry, {
      requestId: "req-1",
      userId: "user-1",
      username: "ada",
      organizationId: "org-1",
      organizationName: "Alpha",
    });
  });

  // 仅 requestId 的最小上下文仍可安全记录。
  test("注入最小请求上下文", () => {
    const logger = createLogger("api");
    const entry = requestAls.run({ requestId: "req-min" }, () => logger.formatEntry("info", "handled"));
    expectEntry(entry, { requestId: "req-min" });
    expect(entry.userId).toBeUndefined();
  });

  // 空字符串上下文字段不会污染日志索引。
  test("忽略空字符串上下文字段", () => {
    const logger = createLogger("api");
    const entry = requestAls.run(
      { requestId: "", userId: "", username: "", organizationId: "", organizationName: "" },
      () => logger.formatEntry("info", "handled"),
    );
    expect(entry.requestId).toBeUndefined();
    expect(entry.userId).toBeUndefined();
    expect(entry.username).toBeUndefined();
  });

  // 嵌套上下文只使用当前异步作用域的租户信息。
  test("嵌套上下文隔离", () => {
    const logger = createLogger("api");
    const outer = requestAls.run({ requestId: "outer", organizationId: "org-a" }, () => {
      const inner = requestAls.run({ requestId: "inner", organizationId: "org-b" }, () =>
        logger.formatEntry("info", "inner"),
      );
      const resumed = logger.formatEntry("info", "outer");
      return { inner, resumed };
    });
    expectEntry(outer.inner, { requestId: "inner", organizationId: "org-b" });
    expectEntry(outer.resumed, { requestId: "outer", organizationId: "org-a" });
  });

  // 并发异步链路之间不能串写请求身份。
  test("并发异步上下文隔离", async () => {
    const logger = createLogger("api");
    const [first, second] = await Promise.all([
      requestAls.run({ requestId: "req-a", userId: "a" }, async () => {
        await Promise.resolve();
        return logger.formatEntry("info", "a");
      }),
      requestAls.run({ requestId: "req-b", userId: "b" }, async () => {
        await Promise.resolve();
        return logger.formatEntry("info", "b");
      }),
    ]);
    expectEntry(first, { requestId: "req-a", userId: "a" });
    expectEntry(second, { requestId: "req-b", userId: "b" });
  });

  // 不同 logger 实例保持各自模块标签。
  test("隔离 logger 模块标签", () => {
    const first = createLogger("first").formatEntry("info", "same");
    const second = createLogger("second").formatEntry("info", "same");
    expect(first.module).toBe("first");
    expect(second.module).toBe("second");
  });

  // info 调用接受纯字符串参数。
  test("info 接受字符串参数", () => {
    expect(() => createLogger("emit").info("created")).not.toThrow();
  });

  // warn 调用接受纯字符串参数。
  test("warn 接受字符串参数", () => {
    expect(() => createLogger("emit").warn("retry")).not.toThrow();
  });

  // error 调用接受 Error 诊断对象。
  test("error 接受 Error 参数", () => {
    expect(() => createLogger("emit").error(new Error("failed"))).not.toThrow();
  });

  // debug 调用接受对象诊断字段。
  test("debug 接受对象参数", () => {
    expect(() => createLogger("emit").debug({ phase: "prepare" })).not.toThrow();
  });

  // 旧 log API 继续映射到 info 路径。
  test("log 保持兼容入口", () => {
    expect(() => createLogger("emit").log("legacy")).not.toThrow();
  });

  // 混合字符串会保持调用顺序进入消息序列化路径。
  test("info 接受多个字符串", () => {
    expect(() => createLogger("emit").info("task", "started", "now")).not.toThrow();
  });

  // 数字参数可作为诊断信息安全序列化。
  test("info 接受数字参数", () => {
    expect(() => createLogger("emit").info("attempt", 3)).not.toThrow();
  });

  // 布尔参数可作为诊断信息安全序列化。
  test("warn 接受布尔参数", () => {
    expect(() => createLogger("emit").warn("retryable", false)).not.toThrow();
  });

  // null 参数会被跳过而不导致日志调用失败。
  test("debug 忽略 null 参数", () => {
    expect(() => createLogger("emit").debug("optional", null)).not.toThrow();
  });

  // undefined 参数会被跳过而不导致日志调用失败。
  test("debug 忽略 undefined 参数", () => {
    expect(() => createLogger("emit").debug("optional", undefined)).not.toThrow();
  });

  // 普通对象经 JSON 序列化后可安全写入日志。
  test("info 序列化普通对象", () => {
    expect(() => createLogger("emit").info({ id: "task-1", nested: { state: "ready" } })).not.toThrow();
  });

  // 数组参数经 JSON 序列化后可安全写入日志。
  test("info 序列化数组", () => {
    expect(() => createLogger("emit").info(["one", "two"])).not.toThrow();
  });

  // 循环对象序列化失败时回退为字符串且不影响主流程。
  test("info 回退循环对象序列化", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => createLogger("emit").info(circular)).not.toThrow();
  });

  // Error 与文本混合时保留异常诊断路径。
  test("warn 混合 Error 与文本", () => {
    expect(() => createLogger("emit").warn("request failed", new Error("timeout"))).not.toThrow();
  });

  // Error 位于首位时仍可生成可读消息。
  test("error 以 Error 消息作为首个文本", () => {
    expect(() => createLogger("emit").error(new Error("database unavailable"))).not.toThrow();
  });

  // 多个 Error 不会导致日志诊断流程抛出异常。
  test("error 接受多个 Error", () => {
    expect(() => createLogger("emit").error(new Error("first"), new Error("second"))).not.toThrow();
  });

  // 非 Error 的 Date 对象可经标准序列化路径记录。
  test("info 序列化 Date", () => {
    expect(() => createLogger("emit").info(new Date("2026-08-19T00:00:00.000Z"))).not.toThrow();
  });

  // 自定义 toJSON 对象可以提供稳定的序列化表示。
  test("info 使用自定义 toJSON", () => {
    const value = { toJSON: () => ({ safe: true }) };
    expect(() => createLogger("emit").info(value)).not.toThrow();
  });

  // 独立请求结束后不会把身份泄漏给后续无上下文日志。
  test("请求上下文结束后清理", () => {
    const logger = createLogger("api");
    requestAls.run({ requestId: "transient" }, () => logger.formatEntry("info", "inside"));
    expect(logger.formatEntry("info", "outside").requestId).toBeUndefined();
  });

  // 调用方提供的额外 requestId 可在明确需要时覆盖 ALS 上下文。
  test("额外字段可覆盖 ALS 请求标识", () => {
    const logger = createLogger("api");
    const entry = requestAls.run({ requestId: "ambient" }, () =>
      logger.formatEntry("info", "forwarded", { requestId: "explicit" }),
    );
    expect(entry.requestId).toBe("explicit");
  });

  // 异步请求结束后并行新日志仍不带旧租户上下文。
  test("异步上下文结束后清理", async () => {
    const logger = createLogger("api");
    await requestAls.run({ requestId: "temporary" }, async () => {
      await Promise.resolve();
      expect(logger.formatEntry("info", "inside").requestId).toBe("temporary");
    });
    expect(logger.formatEntry("info", "after").requestId).toBeUndefined();
  });
});
