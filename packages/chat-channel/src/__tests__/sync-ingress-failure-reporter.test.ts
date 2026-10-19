// packages/chat-channel/src/__tests__/sync-ingress-failure-reporter.test.ts
// live ingress 失败：计数持续累加，日志按 5s 窗口有界输出。

import { describe, expect, test } from "bun:test";
import { SyncProtocolError } from "../sync/protocol/errors";
import { createIngressFailureReporter } from "../sync/runtime/ingress-failure-reporter";

describe("ingress failure reporter", () => {
  // 同一窗口内重复失败只输出一条摘要，但计数每次累加，供观测信号使用。
  test("同窗口只记一条日志，计数持续累加", () => {
    let now = 1_000;
    const logs: Array<{ message: string; code: string | null }> = [];
    const reporter = createIngressFailureReporter({
      now: () => now,
      report: (message, error) => {
        logs.push({
          message,
          code: error instanceof SyncProtocolError ? error.code : null,
        });
      },
    });
    for (let index = 0; index < 10; index += 1) {
      reporter.report(new SyncProtocolError("CAPACITY_EXCEEDED", { message: "full" }));
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toContain("total=1");
    expect(logs[0]?.code).toBe("CAPACITY_EXCEEDED");
    expect(reporter.diagnostics()).toEqual({ total: 10, lastCode: "CAPACITY_EXCEEDED" });

    now += 5_000;
    reporter.report(new SyncProtocolError("CAPACITY_EXCEEDED", { message: "full" }));
    expect(logs).toHaveLength(2);
    expect(logs[1]?.message).toContain("total=11");
  });

  // 非协议错误也计数，但 lastCode 为空，日志以 UNKNOWN 标注。
  test("未知错误只计数并以 UNKNOWN 标注", () => {
    const logs: string[] = [];
    const reporter = createIngressFailureReporter({
      now: () => 1,
      report: (message) => logs.push(message),
    });
    reporter.report(new Error("boom"));
    expect(reporter.diagnostics()).toEqual({ total: 1, lastCode: null });
    expect(logs[0]).toContain("code=UNKNOWN");
  });
});
