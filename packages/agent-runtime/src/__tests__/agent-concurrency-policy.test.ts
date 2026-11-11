import { describe, expect, test } from "bun:test";
import {
  AgentConcurrencyPolicyService,
  type ConcurrencyPolicyRepository,
} from "../server/services/agent-concurrency-policy";

function fixture() {
  let rows: Awaited<ReturnType<ConcurrencyPolicyRepository["list"]>> = [];
  let failure = false;
  const repository: ConcurrencyPolicyRepository = {
    list: async () => {
      if (failure) throw new Error("database unavailable");
      return rows;
    },
    save: async (userId, values) => {
      if (failure) throw new Error("database unavailable");
      rows = [...rows.filter((row) => row.userId !== userId), { userId, ...values }];
    },
    delete: async (userId) => {
      rows = rows.filter((row) => row.userId !== userId);
    },
  };
  return {
    service: new AgentConcurrencyPolicyService(repository, () => ({
      agentMaxConcurrency: 20,
      userAgentMaxConcurrency: 3,
      scheduledAgentMaxConcurrency: 5,
    })),
    fail: () => {
      failure = true;
    },
  };
}

describe("dynamic concurrency policy", () => {
  // 未完成启动加载时必须拒绝同步准入，数据库失败也不得开放。
  test("denies admission until initial load succeeds", async () => {
    const { service, fail } = fixture();
    expect(() => service.limits("u1")).toThrow("not initialized");
    fail();
    await expect(service.initialize()).rejects.toThrow("database unavailable");
    expect(() => service.limits("u1")).toThrow("not initialized");
  });
  // 环境配置、全局覆盖和用户覆盖按优先级生效，删除恢复继承。
  test("inherits env and restores inheritance after clearing overrides", async () => {
    const { service } = fixture();
    await service.initialize();
    expect(service.describe("u1").userAgentMaxConcurrency).toEqual({ override: null, value: 3, source: "environment" });
    await service.patchGlobal({ userAgentMaxConcurrency: 7, agentMaxConcurrency: 30 });
    expect(service.limits("u1")).toEqual({
      agentMaxConcurrency: 30,
      userAgentMaxConcurrency: 7,
      scheduledAgentMaxConcurrency: 5,
    });
    await service.putUser("u1", 2);
    expect(service.describe("u1").userAgentMaxConcurrency).toEqual({ override: 2, value: 2, source: "user" });
    await service.deleteUser("u1");
    expect(service.describe("u1").userAgentMaxConcurrency.source).toBe("global");
    await service.patchGlobal({ userAgentMaxConcurrency: null });
    expect(service.limits("u1").userAgentMaxConcurrency).toBe(3);
  });
  // 非正整数不得进入持久层或运行快照。
  test("rejects invalid limits", async () => {
    const { service } = fixture();
    await service.initialize();
    for (const value of [0, -1, 1.5, Number.NaN]) {
      await expect(service.putUser("u1", value)).rejects.toThrow();
      await expect(service.patchGlobal({ agentMaxConcurrency: value })).rejects.toThrow();
    }
    expect(service.limits("u1").agentMaxConcurrency).toBe(20);
  });
  // 写入失败时保留最后已提交的有效配置，后续写入仍能执行。
  test("does not publish failed writes", async () => {
    const { service, fail } = fixture();
    await service.initialize();
    await service.patchGlobal({ userAgentMaxConcurrency: 4 });
    fail();
    await expect(service.patchGlobal({ userAgentMaxConcurrency: 8 })).rejects.toThrow("database unavailable");
    expect(service.limits("u1").userAgentMaxConcurrency).toBe(4);
  });
  // 并发部分更新必须串行合并，不能互相覆盖。
  test("serializes management writes", async () => {
    const { service } = fixture();
    await service.initialize();
    await Promise.all([
      service.patchGlobal({ agentMaxConcurrency: 9 }),
      service.patchGlobal({ userAgentMaxConcurrency: 6 }),
    ]);
    expect(service.limits("u1")).toEqual({
      agentMaxConcurrency: 9,
      userAgentMaxConcurrency: 6,
      scheduledAgentMaxConcurrency: 5,
    });
  });
});
