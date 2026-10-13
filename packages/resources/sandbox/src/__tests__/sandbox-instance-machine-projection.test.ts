/**
 * 机器注册 / 心跳在 `sandbox_instance` 上的投影（§1.7 B4 前置：投影写路径移到沙盒侧）。
 *
 * 写入口是 `MachineLifecyclePort` 的两个通知，实现在本包仓储。用例替换 DB 句柄、只断言「写了什么」与
 * 「命中哪些行」——机器侧只通报事件（`machine/src/server/machine-lifecycle-port.ts`），投影语义在这里，
 * 因此这条覆盖随实现一起从 machine 包迁过来。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import {
  markSandboxInstancesReadyForMachine,
  touchSandboxInstancesHeartbeatByMachine,
} from "@fenix/resource-sandbox/server";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

/** 记录一次 UPDATE 的 set 载荷与 where 条件，替代真实 DB 句柄。 */
function captureUpdate(): {
  payloads: Record<string, unknown>[];
  conditions: SQL[];
} {
  const captured = { payloads: [] as Record<string, unknown>[], conditions: [] as SQL[] };
  stubDb({
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async (condition: SQL) => {
          captured.payloads.push(values);
          captured.conditions.push(condition);
        },
      }),
    }),
  });
  return captured;
}

describe("沙盒实例的机器事件投影", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 机器注册意味着该机器上仍在创建 / 启动 / 恢复的实例已经可用，必须提升为 ready。
  test("机器注册把中间态实例提升为 ready 并同步心跳时间", async () => {
    const captured = captureUpdate();
    const at = new Date("2026-09-22T00:00:00.000Z");

    await markSandboxInstancesReadyForMachine("mach_1", at);

    expect(captured.payloads).toEqual([{ status: "ready", lastHeartbeatAt: at, updatedAt: at }]);
    const { sql, params } = dialect.sqlToQuery(captured.conditions[0]);
    expect(params).toEqual(["mach_1", "creating", "starting", "recovering"]);
    expect(sql).toContain('"machine_id" =');
  });

  // 终态不得被复活：提升集合里没有 destroyed / error，机器重连不会把已销毁实例改回可用。
  test("机器注册不触及终态实例", async () => {
    const captured = captureUpdate();

    await markSandboxInstancesReadyForMachine("mach_1", new Date("2026-09-22T00:00:00.000Z"));

    const { params } = dialect.sqlToQuery(captured.conditions[0]);
    expect(params).not.toContain("destroyed");
    expect(params).not.toContain("error");
    expect(params).not.toContain("ready");
  });

  // 心跳只刷新活跃时间，不推进状态：状态由实例自己的生命周期（provider 创建 / 恢复）决定。
  test("机器心跳只更新时间戳、不改状态", async () => {
    const captured = captureUpdate();
    const at = new Date("2026-09-22T01:00:00.000Z");

    await touchSandboxInstancesHeartbeatByMachine("mach_1", at);

    expect(captured.payloads).toEqual([{ lastHeartbeatAt: at, updatedAt: at }]);
    expect(captured.payloads[0]).not.toHaveProperty("status");
    const { sql, params } = dialect.sqlToQuery(captured.conditions[0]);
    expect(params).toEqual(["mach_1"]);
    expect(sql).toContain('"machine_id" =');
  });
});
