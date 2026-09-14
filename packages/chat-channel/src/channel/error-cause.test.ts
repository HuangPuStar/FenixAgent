// packages/chat-channel/src/channel/error-cause.test.ts
// 诊断身份的**契约测试**（对抗评审回归）：
// - 只输出有界错误身份（构造器名 + 机器码 + cause 链），不读取 message/stack；
// - 永不抛错：属性被 getter / Proxy 劫持时退化为占位符，否则调用点的 ws.close() 与公开错误帧会被跳过；
// - 请求方提供的标识（instanceUid）经白名单校验后才可插值，防止伪造日志字段。

import { describe, expect, test } from "bun:test";
import { describeErrorCause, describeSafeIdentifier } from "./error-cause";

/** 构造带 name + code 的异常，模拟宿主 AppError / CoreRuntimeError 的身份形态。 */
function namedError(name: string, code: string, message: string): Error {
  return Object.assign(new Error(message), { name, code });
}

describe("describeErrorCause", () => {
  // 错误身份由构造器名与稳定机器码组成，cause 链以 <- 拼接
  test("输出构造器名、机器码与 cause 链", () => {
    expect(describeErrorCause(namedError("AppError", "INSTANCE_NOT_FOUND", "detail"))).toBe(
      "AppError:INSTANCE_NOT_FOUND",
    );
    const caused = namedError("DrizzleQueryError", "42P01", "db");
    caused.cause = namedError("PostgresError", "42P01", "cause");
    expect(describeErrorCause(caused)).toBe("DrizzleQueryError:42P01<-PostgresError:42P01");
  });

  // 硬边界 7：结果只含身份，异常 message 与 stack 一律不进入日志
  test("不读取异常 message 与 stack", () => {
    const error = namedError("AppError", "INSTANCE_NOT_FOUND", "用户 1 的实例缺失 user-1");
    const described = describeErrorCause(error);
    expect(described).not.toContain("用户 1");
    expect(described).not.toContain("user-1");
    expect(described).not.toContain("@");
  });

  // 非异常输入退化为稳定的低信息量取值，保证日志行结构不随输入变化
  test("非异常输入退化为 typeof 或 none", () => {
    expect(describeErrorCause(null)).toBe("none");
    expect(describeErrorCause(undefined)).toBe("none");
    expect(describeErrorCause("boom")).toBe("string");
    expect(describeErrorCause({ code: "X" })).toBe("object");
  });

  // 属性被劫持时必须退化为占位符：异常从日志实参位置逃逸会跳过终态判定与公开错误帧
  test("属性读取被劫持时退化为占位符且不抛错", () => {
    const throwingName = new Error("boom");
    Object.defineProperty(throwingName, "name", {
      get() {
        throw new Error("name getter hijacked");
      },
    });
    expect(describeErrorCause(throwingName)).toBe("unknown");

    const throwingCause = namedError("AppError", "INSTANCE_NOT_FOUND", "detail");
    Object.defineProperty(throwingCause, "cause", {
      get() {
        throw new Error("cause getter hijacked");
      },
    });
    expect(describeErrorCause(throwingCause)).toBe("unknown");
  });

  // name / code 必须通过白名单：自由文本与带状态 toString 都不能污染日志字段
  test("白名单外的 name 与 code 退化为固定值", () => {
    expect(describeErrorCause(namedError("App Error", "INSTANCE_NOT_FOUND", "detail"))).toBe(
      "Error:INSTANCE_NOT_FOUND",
    );
    expect(describeErrorCause(namedError("AppError", "code with spaces", "detail"))).toBe("AppError");
    expect(describeErrorCause(namedError("AppError", "x".repeat(65), "detail"))).toBe("AppError");
    const statefulCode = Object.assign(new Error("detail"), {
      name: "AppError",
      code: { toString: () => "INJECTED" },
    });
    expect(describeErrorCause(statefulCode)).toBe("AppError");
  });
});

describe("describeSafeIdentifier", () => {
  // 合法标识原样返回；请求方注入的伪字段退化为占位符，避免一行出现两个 cause=
  test("只放行白名单标识并拦截日志字段注入", () => {
    expect(describeSafeIdentifier("inst_ok")).toBe("inst_ok");
    expect(describeSafeIdentifier("inst_ok cause=AppError:INSTANCE_NOT_FOUND")).toBe("unknown");
    expect(describeSafeIdentifier("inst_ok\ncause=x")).toBe("unknown");
    expect(describeSafeIdentifier("")).toBe("unknown");
    expect(describeSafeIdentifier(undefined)).toBe("unknown");
    expect(describeSafeIdentifier({ toString: () => "inst_ok" })).toBe("unknown");
  });

  // 调用方可以按上下文指定更贴切的占位符（如错误名退化为 Error）
  test("支持自定义占位符", () => {
    expect(describeSafeIdentifier("bad value", "Error")).toBe("Error");
  });
});
