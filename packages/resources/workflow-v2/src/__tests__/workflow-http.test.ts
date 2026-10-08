// 控制面「上游失败 → HTTP 状态与错误码」的映射（3C 的复核项）：熔断打开、会话不可用、超时、网络与未预期
// 失败必须落在同一张分类表上，且与画布面 `mapUpstreamFailure` 的 502/503/504 口径一致——两套映射是这次
// 复核明确要避免的东西。
//
// 这里只测映射本身（纯函数 + 错误实例），不发请求、不碰数据库。

import { describe, expect, test } from "bun:test";
import { bindingFailure, upstreamAuditResult, upstreamFailure } from "../server/routes/web/workflow-http";
import { UpstreamCircuitOpenError, UpstreamRequestError } from "../server/services/upstream-client";
import { UpstreamSessionUnavailableError } from "../server/services/upstream-session";

/** 上游业务失败响应的最小形状（`code≠0` 即业务失败，见契约快照 §3 F5）。 */
const envelope = (code: number, msg = "boom") => ({ status: 200, body: { code, msg } });

describe("控制面上游失败映射", () => {
  // 熔断打开是「没发出请求的失败」：503 让客户端知道是暂不可用、可稍后重试，而不是 500 的内部错误。
  test("熔断打开 → 503 且错误码为上游不可用", () => {
    const failure = upstreamFailure("测试动作", { thrown: new UpstreamCircuitOpenError("/api/x", 1000) }, {});

    expect(failure.httpStatus).toBe(503);
    expect(failure.body.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(upstreamAuditResult(failure)).toBe("upstream_unavailable");
  });

  // 会话不可用（登录失败、重放仍失效）与熔断同级：都是「上游侧暂时不可用」，503 可重试，但不能当成业务拒绝。
  test("会话不可用 → 503 且错误码区分于熔断", () => {
    const failure = upstreamFailure("测试动作", { thrown: new UpstreamSessionUnavailableError("rejected", "x") }, {});

    expect(failure.httpStatus).toBe(503);
    expect(failure.body.code).toBe("PLATFORM_SESSION_UNAVAILABLE");
    expect(upstreamAuditResult(failure)).toBe("upstream_unavailable");
  });

  // 超时是「上游慢」而非「上游错」：504 让客户端与网关按超时处置（与画布面一致）。
  test("超时 → 504", () => {
    const failure = upstreamFailure(
      "测试动作",
      { thrown: new UpstreamRequestError("UPSTREAM_TIMEOUT", "timeout 30ms") },
      {},
    );

    expect(failure.httpStatus).toBe(504);
    expect(failure.body.code).toBe("UPSTREAM_TIMEOUT");
  });

  // 网络错误 → 502：连接根本没建立，属于网关类失败。
  test("网络错误 → 502", () => {
    const failure = upstreamFailure(
      "测试动作",
      { thrown: new UpstreamRequestError("UPSTREAM_NETWORK_ERROR", "connect refused") },
      {},
    );

    expect(failure.httpStatus).toBe(502);
    expect(failure.body.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  // 未预期错误（我方入参/配置问题）保守映射为 502：对外只给固定文案，原因留在日志里。
  test("未预期错误 → 502 且不回显原始错误", () => {
    const failure = upstreamFailure("测试动作", { thrown: new Error("secret-ish internal detail") }, {});

    expect(failure.httpStatus).toBe(502);
    expect(JSON.stringify(failure.body)).not.toContain("secret-ish");
  });

  // 上游回了业务码说明「上游活着但拒绝」：502 + UPSTREAM_REJECTED，且审计标签与可用性失败区分开。
  test("上游业务失败 → 502 且审计标签为 upstream_rejected", () => {
    const failure = upstreamFailure("测试动作", { result: envelope(777777775, "panic stack …") }, {});

    expect(failure.httpStatus).toBe(502);
    expect(failure.body.code).toBe("UPSTREAM_REJECTED");
    // panic 码的 msg 是 Go 堆栈：只进日志，绝不进响应。
    expect(JSON.stringify(failure.body)).not.toContain("panic stack");
    expect(upstreamAuditResult(failure)).toBe("upstream_rejected");
  });

  // 租户绑定状态决定「能不能动作」：未绑定 409（先绑 App），降级 503（暂时不可用可重试）。
  test("租户绑定失败按未绑定与降级分别映射 409/503", () => {
    expect(bindingFailure("not_bound")).toEqual({
      httpStatus: 409,
      body: { code: "ORG_APP_NOT_BOUND", message: expect.any(String) },
    });
    expect(bindingFailure("degraded").httpStatus).toBe(503);
    expect(bindingFailure("degraded").body.code).toBe("PLATFORM_ACCOUNT_DEGRADED");
  });
});
