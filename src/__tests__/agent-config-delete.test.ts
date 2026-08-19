import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { globalInstanceRegistry } from "../services/instance-registry";
import { resetOrchestrationInstanceDeps, setOrchestrationInstanceDeps } from "../services/orchestration-instance";
import { _resetDeps } from "../services/resource-permission";
import { resetAllStubs, stubCoreBootstrap, stubDb, stubResourcePermissionRepo } from "../test-utils/helpers";

const now = new Date("2026-07-08T00:00:00.000Z");

const AGENT_ROW = {
  id: "agc_1",
  organizationId: "org_1",
  userId: "user_1",
  name: "demo-agent",
  prompt: null,
  model: null,
  modelId: null,
  description: null,
  extra: null,
  machineId: null,
  createdAt: now,
  updatedAt: now,
};

/** core facade：无 core 快照，stopInstance 静默成功（helper 三路收集的安全依赖）。 */
const fakeFacade = {
  listInstances: () => [],
  stopInstance: async () => {},
} as unknown as CoreRuntimeFacade;

/** 编排域 fake controller：活跃表为空，stopInstance 静默成功。 */
const fakeController = {
  listInstances: () => [],
  stopInstance: async () => {},
} as unknown as AgentController;

describe("deleteAgentConfig", () => {
  beforeEach(() => {
    resetAllStubs();
    globalInstanceRegistry.clear();
    resetOrchestrationInstanceDeps();
    // deleteAgentConfig 删除前会调 stopInstancesForEnvironments（三路收集依赖
    // getCoreRuntime / getOrchestrationController），必须注入 fake，否则 preload
    // mock 未配置时 getCoreRuntime 返回 undefined → listInstances 抛 TypeError
    // （同 workflow-cleanup.test.ts 的教训）。
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    setOrchestrationInstanceDeps({
      getOrchestrationController: () => fakeController,
      reclaimYjsDocs: async () => {},
    });
    // 模块首载时 resource-permission 的 mock.module 尚未替换（bun 惰性替换），
    // _deps.repo 绑定的是真实实现；_resetDeps 重新赋值后 stub 才生效
    _resetDeps();
    stubResourcePermissionRepo({
      listOwnedByOrganization: async () => [],
    });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    resetOrchestrationInstanceDeps();
    resetAllStubs();
  });

  test("deletes bound environments before deleting the agent config", async () => {
    const deleteCalls: string[] = [];

    stubDb({
      select: (projection?: unknown) => {
        if (projection) {
          // 有投影：deleteAgentConfig 删除前收集绑定 envIds（listNamesByIds 的组织
          // 查询同样走此分支，返回空不影响 decorateResourceAccess 的 org 名映射）
          return {
            from: () => ({
              where: async () => [{ id: "env_1" }],
            }),
          };
        }
        // 无投影：getAgentConfig 的 agent config 查询
        return {
          from: () => ({
            where: () => Object.assign(Promise.resolve([AGENT_ROW]), { limit: async () => [AGENT_ROW] }),
          }),
        };
      },
      transaction: async (callback: (tx: Record<string, unknown>) => Promise<boolean>) =>
        callback({
          delete: () => ({
            where: () => {
              deleteCalls.push(deleteCalls.length === 0 ? "environment" : "agent_config");
              if (deleteCalls.at(-1) === "agent_config") {
                return {
                  returning: async () => [{ id: "agc_1" }],
                };
              }
              return Promise.resolve({ count: 2 });
            },
          }),
        }),
    });

    const { deleteAgentConfig } = await import("../services/config/agent-config");
    const deleted = await deleteAgentConfig({ organizationId: "org_1", userId: "user_1", role: "owner" }, "demo-agent");

    expect(deleted).toBe(true);
    expect(deleteCalls).toEqual(["environment", "agent_config"]);
  });
});
