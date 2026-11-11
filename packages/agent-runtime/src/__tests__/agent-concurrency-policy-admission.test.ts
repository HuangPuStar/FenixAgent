import { afterEach, expect, test } from "bun:test";
import { AgentConcurrencyPolicyService } from "../server/services/agent-concurrency-policy";
import { setAgentConcurrencyLimitsReaderForTest } from "../server/services/agent-concurrency-policy-state";
import {
  beginSpawnReservation,
  releaseSpawnReservation,
  resetAgentConcurrencyDeps,
  setAgentConcurrencyDeps,
} from "../services/agent-concurrency";
import { acquireAgentExecution } from "../services/agent-execution-admission";

const service = new AgentConcurrencyPolicyService(
  { list: async () => [], save: async () => {}, delete: async () => {} },
  () => ({}),
);
afterEach(() => {
  resetAgentConcurrencyDeps();
  setAgentConcurrencyLimitsReaderForTest();
});

// 动态覆盖必须进入原同步 reservation，同一用户跨来源不能超发。
test("publishes user limits into synchronous spawn reservations", async () => {
  await service.initialize();
  await service.putUser("u1", 1);
  setAgentConcurrencyLimitsReaderForTest((id) => service.limits(id));
  setAgentConcurrencyDeps({ getRuntime: () => ({ listInstances: () => [] }) as never });
  const first = beginSpawnReservation("u1", "interactive");
  expect(() => beginSpawnReservation("u1", "scheduled")).toThrow("当前用户");
  await service.putUser("u1", 2);
  const second = beginSpawnReservation("u1", "interactive");
  expect(() => beginSpawnReservation("u1", "interactive")).toThrow("当前用户");
  releaseSpawnReservation(first);
  releaseSpawnReservation(second);
});

// 定时执行配额继续按执行次数计算，动态降低额度不会遗失已有租约。
test("updates scheduled execution limits without resetting active leases", async () => {
  await service.initialize();
  await service.patchGlobal({ scheduledAgentMaxConcurrency: 2 });
  setAgentConcurrencyLimitsReaderForTest((id) => service.limits(id));
  const first = acquireAgentExecution({ userId: "u1", source: "scheduled" });
  const second = acquireAgentExecution({ userId: "u1", source: "scheduled" });
  try {
    await service.patchGlobal({ scheduledAgentMaxConcurrency: 1 });
    expect(() => acquireAgentExecution({ userId: "u2", source: "scheduled" })).toThrow("execution limit");
    first.release();
    expect(() => acquireAgentExecution({ userId: "u1", source: "scheduled" })).toThrow("execution limit");
    second.release();
    acquireAgentExecution({ userId: "u1", source: "scheduled" }).release();
  } finally {
    first.release();
    second.release();
  }
});

// 启动读取失败必须同时阻挡实例和执行准入。
test("denies both admission paths when policy loading failed", async () => {
  const unavailable = new AgentConcurrencyPolicyService(
    {
      list: async () => {
        throw new Error("offline");
      },
      save: async () => {},
      delete: async () => {},
    },
    () => ({}),
  );
  await expect(unavailable.initialize()).rejects.toThrow("offline");
  setAgentConcurrencyLimitsReaderForTest((id) => unavailable.limits(id));
  setAgentConcurrencyDeps({ getRuntime: () => ({ listInstances: () => [] }) as never });
  expect(() => beginSpawnReservation("u1", "interactive")).toThrow("not initialized");
  expect(() => acquireAgentExecution({ userId: "u1", source: "scheduled" })).toThrow("not initialized");
});
