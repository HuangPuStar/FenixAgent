import { describe, expect, test } from "bun:test";
import { createLogger, requestAls } from "../index";

function entry(level: "info" | "warn" | "error" | "debug", message: string, extra?: Record<string, unknown>) {
  return createLogger("round-27").formatEntry(level, message, extra);
}

describe("logger 内存协议与上下文隔离 round27", () => {
  // info 协议条目保留指定消息。
  test("info 条目保留消息", () => {
    expect(entry("info", "created")).toMatchObject({ level: "info", module: "round-27", message: "created" });
  });

  // warn 协议条目保留指定消息。
  test("warn 条目保留消息", () => {
    expect(entry("warn", "retry")).toMatchObject({ level: "warn", module: "round-27", message: "retry" });
  });

  // error 协议条目保留指定消息。
  test("error 条目保留消息", () => {
    expect(entry("error", "failed")).toMatchObject({ level: "error", module: "round-27", message: "failed" });
  });

  // debug 协议条目保留指定消息。
  test("debug 条目保留消息", () => {
    expect(entry("debug", "details")).toMatchObject({ level: "debug", module: "round-27", message: "details" });
  });

  // 时间戳使用可解析的 ISO 协议格式。
  test("时间戳是 ISO 字符串", () => {
    const value = entry("info", "timestamp").timestamp;
    expect(new Date(value).toISOString()).toBe(value);
  });

  // 数字附加字段完整保留。
  test("保留数字附加字段", () => {
    expect(entry("info", "count", { count: 0 })).toMatchObject({ count: 0 });
  });

  // 布尔附加字段完整保留。
  test("保留布尔附加字段", () => {
    expect(entry("info", "flag", { enabled: false })).toMatchObject({ enabled: false });
  });

  // 空字符串附加字段不会被格式化器剔除。
  test("保留空字符串附加字段", () => {
    expect(entry("info", "empty", { value: "" })).toMatchObject({ value: "" });
  });

  // null 附加字段完整保留。
  test("保留 null 附加字段", () => {
    expect(entry("info", "null", { value: null })).toMatchObject({ value: null });
  });

  // undefined 附加字段保持调用方对象语义。
  test("保留 undefined 附加字段", () => {
    expect(entry("info", "undefined", { value: undefined })).toHaveProperty("value", undefined);
  });

  // 数组附加字段不被展平。
  test("保留数组附加字段", () => {
    expect(entry("info", "array", { values: ["a", "b"] })).toMatchObject({ values: ["a", "b"] });
  });

  // 嵌套对象附加字段不被改写。
  test("保留嵌套对象附加字段", () => {
    expect(entry("info", "object", { payload: { id: "job-1" } })).toMatchObject({ payload: { id: "job-1" } });
  });

  // 附加字段可以包含错误分类文本。
  test("保留错误分类字段", () => {
    expect(entry("error", "failed", { code: "E_TIMEOUT" })).toMatchObject({ code: "E_TIMEOUT" });
  });

  // 附加字段可以包含资源标识。
  test("保留资源标识字段", () => {
    expect(entry("info", "released", { resourceId: "resource-1" })).toMatchObject({ resourceId: "resource-1" });
  });

  // 附加字段可以包含协议版本。
  test("保留协议版本字段", () => {
    expect(entry("info", "handshake", { protocolVersion: 1 })).toMatchObject({ protocolVersion: 1 });
  });

  // 不在请求作用域时不产生 requestId。
  test("无请求作用域时省略 requestId", () => {
    expect(entry("info", "idle").requestId).toBeUndefined();
  });

  // 不在请求作用域时不产生 userId。
  test("无请求作用域时省略 userId", () => {
    expect(entry("info", "idle").userId).toBeUndefined();
  });

  // 不在请求作用域时不产生 username。
  test("无请求作用域时省略 username", () => {
    expect(entry("info", "idle").username).toBeUndefined();
  });

  // 不在请求作用域时不产生组织标识。
  test("无请求作用域时省略 organizationId", () => {
    expect(entry("info", "idle").organizationId).toBeUndefined();
  });

  // 不在请求作用域时不产生组织名称。
  test("无请求作用域时省略 organizationName", () => {
    expect(entry("info", "idle").organizationName).toBeUndefined();
  });

  // 最小上下文注入 requestId。
  test("注入最小 requestId", () => {
    const result = requestAls.run({ requestId: "request-1" }, () => entry("info", "handled"));
    expect(result).toMatchObject({ requestId: "request-1" });
  });

  // 用户标识在请求作用域内传播。
  test("注入 userId", () => {
    const result = requestAls.run({ requestId: "request-2", userId: "user-2" }, () => entry("info", "handled"));
    expect(result).toMatchObject({ userId: "user-2" });
  });

  // 用户名在请求作用域内传播。
  test("注入 username", () => {
    const result = requestAls.run({ requestId: "request-3", username: "ada" }, () => entry("info", "handled"));
    expect(result).toMatchObject({ username: "ada" });
  });

  // 组织标识在请求作用域内传播。
  test("注入 organizationId", () => {
    const result = requestAls.run({ requestId: "request-4", organizationId: "org-4" }, () => entry("info", "handled"));
    expect(result).toMatchObject({ organizationId: "org-4" });
  });

  // 组织名称在请求作用域内传播。
  test("注入 organizationName", () => {
    const result = requestAls.run({ requestId: "request-5", organizationName: "Alpha" }, () =>
      entry("info", "handled"),
    );
    expect(result).toMatchObject({ organizationName: "Alpha" });
  });

  // 完整上下文的每个字段可同时传播。
  test("注入完整请求上下文", () => {
    const result = requestAls.run(
      { requestId: "request-6", userId: "user-6", username: "bob", organizationId: "org-6", organizationName: "Beta" },
      () => entry("info", "handled"),
    );
    expect(result).toMatchObject({
      requestId: "request-6",
      userId: "user-6",
      username: "bob",
      organizationId: "org-6",
      organizationName: "Beta",
    });
  });

  // 空 requestId 不污染结构化日志。
  test("忽略空 requestId", () => {
    const result = requestAls.run({ requestId: "" }, () => entry("info", "handled"));
    expect(result.requestId).toBeUndefined();
  });

  // 空 userId 不污染结构化日志。
  test("忽略空 userId", () => {
    const result = requestAls.run({ requestId: "request-7", userId: "" }, () => entry("info", "handled"));
    expect(result.userId).toBeUndefined();
  });

  // 空 username 不污染结构化日志。
  test("忽略空 username", () => {
    const result = requestAls.run({ requestId: "request-8", username: "" }, () => entry("info", "handled"));
    expect(result.username).toBeUndefined();
  });

  // 空组织标识不污染结构化日志。
  test("忽略空 organizationId", () => {
    const result = requestAls.run({ requestId: "request-9", organizationId: "" }, () => entry("info", "handled"));
    expect(result.organizationId).toBeUndefined();
  });

  // 空组织名称不污染结构化日志。
  test("忽略空 organizationName", () => {
    const result = requestAls.run({ requestId: "request-10", organizationName: "" }, () => entry("info", "handled"));
    expect(result.organizationName).toBeUndefined();
  });

  // 内层作用域覆盖外层 requestId。
  test("内层上下文覆盖 requestId", () => {
    const result = requestAls.run({ requestId: "outer" }, () =>
      requestAls.run({ requestId: "inner" }, () => entry("info", "nested")),
    );
    expect(result.requestId).toBe("inner");
  });

  // 内层作用域结束后恢复外层 requestId。
  test("内层上下文结束后恢复 requestId", () => {
    const result = requestAls.run({ requestId: "outer" }, () => {
      requestAls.run({ requestId: "inner" }, () => entry("info", "nested"));
      return entry("info", "outer");
    });
    expect(result.requestId).toBe("outer");
  });

  // 内层作用域不会继承未提供的外层用户标识。
  test("内层上下文隔离 userId", () => {
    const result = requestAls.run({ requestId: "outer", userId: "outer-user" }, () =>
      requestAls.run({ requestId: "inner" }, () => entry("info", "nested")),
    );
    expect(result.userId).toBeUndefined();
  });

  // 内层作用域不会继承未提供的外层组织标识。
  test("内层上下文隔离 organizationId", () => {
    const result = requestAls.run({ requestId: "outer", organizationId: "outer-org" }, () =>
      requestAls.run({ requestId: "inner" }, () => entry("info", "nested")),
    );
    expect(result.organizationId).toBeUndefined();
  });

  // 相邻请求作用域之间不泄露 requestId。
  test("相邻请求隔离 requestId", () => {
    const first = requestAls.run({ requestId: "first" }, () => entry("info", "first"));
    const second = requestAls.run({ requestId: "second" }, () => entry("info", "second"));
    expect([first.requestId, second.requestId]).toEqual(["first", "second"]);
  });

  // 请求作用域退出后不泄露 requestId。
  test("请求结束后释放 requestId", () => {
    requestAls.run({ requestId: "finished" }, () => entry("info", "finished"));
    expect(entry("info", "next").requestId).toBeUndefined();
  });

  // 请求作用域退出后不泄露用户标识。
  test("请求结束后释放 userId", () => {
    requestAls.run({ requestId: "finished", userId: "user-finished" }, () => entry("info", "finished"));
    expect(entry("info", "next").userId).toBeUndefined();
  });

  // 附加字段可覆盖模块展示字段。
  test("附加字段覆盖 module", () => {
    expect(entry("info", "message", { module: "override" }).module).toBe("override");
  });

  // 附加字段可覆盖消息展示字段。
  test("附加字段覆盖 message", () => {
    expect(entry("info", "message", { message: "override" }).message).toBe("override");
  });

  // 附加字段可覆盖级别展示字段。
  test("附加字段覆盖 level", () => {
    expect(entry("info", "message", { level: "debug" }).level).toBe("debug");
  });

  // 附加字段可覆盖请求标识。
  test("附加字段覆盖 requestId", () => {
    const result = requestAls.run({ requestId: "context" }, () => entry("info", "message", { requestId: "extra" }));
    expect(result.requestId).toBe("extra");
  });

  // 独立 logger 维护各自模块归属。
  test("独立 logger 隔离模块归属", () => {
    const left = createLogger("left").formatEntry("info", "same");
    const right = createLogger("right").formatEntry("info", "same");
    expect([left.module, right.module]).toEqual(["left", "right"]);
  });

  // 空模块名按调用方输入原样保留。
  test("保留空模块名", () => {
    expect(createLogger("").formatEntry("info", "message").module).toBe("");
  });

  // Unicode 模块名按调用方输入原样保留。
  test("保留 Unicode 模块名", () => {
    expect(createLogger("调度器").formatEntry("info", "message").module).toBe("调度器");
  });

  // 空消息按调用方输入原样保留。
  test("保留空消息", () => {
    expect(entry("info", "").message).toBe("");
  });

  // Unicode 消息按调用方输入原样保留。
  test("保留 Unicode 消息", () => {
    expect(entry("info", "资源已释放").message).toBe("资源已释放");
  });

  // 长消息不会被内存格式化器截断。
  test("保留长消息", () => {
    const message = "x".repeat(4096);
    expect(entry("info", message).message).toBe(message);
  });

  // 格式化不会修改调用方附加对象。
  test("不修改附加对象", () => {
    const extra = { nested: { state: "open" } };
    entry("info", "message", extra);
    expect(extra).toEqual({ nested: { state: "open" } });
  });

  // 多次格式化不会复用同一条目对象。
  test("每次格式化返回独立条目", () => {
    const first = entry("info", "message");
    const second = entry("info", "message");
    expect(first).not.toBe(second);
  });

  // 同一作用域内多次格式化保持请求身份。
  test("同一作用域保持请求身份", () => {
    const result = requestAls.run({ requestId: "stable" }, () => [entry("info", "one"), entry("warn", "two")]);
    expect(result.map((value) => value.requestId)).toEqual(["stable", "stable"]);
  });

  // 异步边界后仍传播请求身份。
  test("异步边界传播请求身份", async () => {
    const result = await requestAls.run({ requestId: "async" }, async () => {
      await Promise.resolve();
      return entry("info", "continued");
    });
    expect(result.requestId).toBe("async");
  });

  // 异步边界后仍传播组织身份。
  test("异步边界传播组织身份", async () => {
    const result = await requestAls.run({ requestId: "async-org", organizationId: "org-async" }, async () => {
      await Promise.resolve();
      return entry("info", "continued");
    });
    expect(result.organizationId).toBe("org-async");
  });
});
