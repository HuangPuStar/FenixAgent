import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { initializeAgentRuntimeModuleConfig, stubAgentRuntimeConfig } from "../server/testing";
import {
  acquireAgentExecution,
  hasActiveAgentExecutions,
  isAgentExecutionIdleReclaimable,
  markAgentExecutionIdleReclaimable,
  releaseAgentExecutions,
} from "../services/agent-execution-admission";
import { globalInstanceRegistry } from "../services/instance-registry";

function register(id: string) {
  globalInstanceRegistry.register(id, {
    userId: "user",
    organizationId: "org",
    environmentId: "env",
    spawnSource: "interactive",
    lastActivityAt: 0,
    relayCount: 0,
    lastRelayDetachedAt: 0,
  });
}

describe("execution source policy", () => {
  beforeEach(() => {
    initializeAgentRuntimeModuleConfig();
    stubAgentRuntimeConfig({ scheduledAgentMaxConcurrency: 1 });
  });
  afterEach(() => {
    releaseAgentExecutions("primary");
    globalInstanceRegistry.clear();
    resetAllStubs();
  });

  // API先启动和定时任务先启动都采用相同执行配额及空闲回收策略。
  test.each(["interactive", "scheduled"] as const)("applies execution policy when %s starts first", (source) => {
    register("primary");
    markAgentExecutionIdleReclaimable("primary");
    const first = acquireAgentExecution({ userId: "user", source });
    first.attach("primary");
    expect(hasActiveAgentExecutions("primary")).toBe(true);
    expect(isAgentExecutionIdleReclaimable("primary")).toBe(false);
    first.release();
    expect(isAgentExecutionIdleReclaimable("primary")).toBe(true);
    const scheduled = acquireAgentExecution({ userId: "user", source: "scheduled" });
    scheduled.attach("primary");
    expect(() => acquireAgentExecution({ userId: "other-user", source: "scheduled" })).toThrow();
    const api = acquireAgentExecution({ userId: "user", source: "interactive" });
    api.attach("primary");
    scheduled.release();
    expect(isAgentExecutionIdleReclaimable("primary")).toBe(false);
    api.release();
    expect(isAgentExecutionIdleReclaimable("primary")).toBe(true);
  });

  // 取消尚未确认的任务仍占额度，直到同实例runtime确认结束。
  test("confirmed runtime termination releases unknown execution admission", () => {
    const lease = acquireAgentExecution({ userId: "user", source: "scheduled" });
    lease.attach("primary");
    lease.confirmRuntime();
    expect(hasActiveAgentExecutions("primary")).toBe(true);
    releaseAgentExecutions("other-instance");
    expect(() => acquireAgentExecution({ userId: "user", source: "scheduled" })).toThrow();
    releaseAgentExecutions("primary");
    const next = acquireAgentExecution({ userId: "user", source: "scheduled" });
    next.release();
    lease.release();
  });

  // 旧实体回收不能释放正在等待ensure的新任务额度，避免恢复后无配额执行。
  test("old runtime stop preserves pending execution admission", () => {
    const pending = acquireAgentExecution({ userId: "user", source: "scheduled" });
    pending.attach("primary");
    releaseAgentExecutions("primary");
    expect(() => acquireAgentExecution({ userId: "user", source: "scheduled" })).toThrow();
    pending.confirmRuntime();
    releaseAgentExecutions("primary");
    expect(() => pending.confirmRuntime()).toThrow();
    pending.release();
  });

  // 准入前已经取消的任务不会占用scheduled配额。
  test("pre-aborted calls acquire no admission", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => acquireAgentExecution({ userId: "user", source: "scheduled", signal: controller.signal })).toThrow();
    const next = acquireAgentExecution({ userId: "user", source: "scheduled" });
    next.release();
  });
});
