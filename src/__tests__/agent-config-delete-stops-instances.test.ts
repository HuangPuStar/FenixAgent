/**
 * deleteAgentConfig 删除前停止绑定 environment 上运行实例的测试（C-R1 修复验证）。
 *
 * 背景：删除 agent_config 只删 DB 行，其绑定 environment 上正在运行的编排实例
 * （Agent 进程 + controller 活跃表 + registry supplement + 并发额度）会残留为资源
 * 泄漏，idle monitor 对 interactive 永不回收（见
 * docs/issues/2026-08-19-agent-delete-instance-leak.md）。修复后 deleteAgentConfig
 * 在 DB 事务前调用 stopInstancesForEnvironments 主动停止实例。
 *
 * 注入方式（禁 mock.module，复用既有 seam）：
 *   - globalInstanceRegistry 为真实单例，beforeEach 清空、用例内注册 supplement；
 *   - core-bootstrap 通过 stubCoreBootstrap 注入 fakeFacade（listInstances 空 +
 *     记录 stopInstance 调用）；
 *   - orchestration-instance 通过 setOrchestrationInstanceDeps 注入 fakeController
 *     （活跃表可操控）与 reclaimYjsDocs spy（避免动态 import relay）；
 *   - resource-permission 经 _resetDeps + stubResourcePermissionRepo 放行内部写；
 *   - db 经 stubDb 提供 agent row / envIds 查询 / 事务删除。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { globalInstanceRegistry } from "../services/instance-registry";
import { resetOrchestrationInstanceDeps, setOrchestrationInstanceDeps } from "../services/orchestration-instance";
import { _resetDeps } from "../services/resource-permission";
import { resetAllStubs, stubCoreBootstrap, stubDb, stubResourcePermissionRepo } from "../test-utils/helpers";

const ORG_1 = "org-1";
const ORG_2 = "org-2";
const NOW = new Date("2026-07-08T00:00:00.000Z");

const AGENT_ROW = {
  id: "agc_1",
  organizationId: ORG_1,
  userId: "user-1",
  name: "demo-agent",
  prompt: null,
  model: null,
  modelId: null,
  description: null,
  extra: null,
  machineId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/** 记录 facade.stopInstance 调用（stopInstanceViaController 的 core 侧）。 */
let stopCalls: string[] = [];
/** 编排域 fake controller 活跃表。 */
const fakeControllerInstances = new Set<string>();
/** 非 null 时 fake controller 对该 id 抛错（模拟 controller 层停止失败）。 */
let controllerStopErrorId: string | null = null;

/** core facade：无 core 快照，stopInstance 记录调用。 */
const fakeFacade = {
  listInstances: () => [],
  stopInstance: async (instanceId: string) => {
    stopCalls.push(instanceId);
  },
} as unknown as CoreRuntimeFacade;

/** 编排域 fake controller：listInstances 返回活跃表（带 environmentId），stopInstance 可注入失败。 */
const fakeController = {
  listInstances: () => [...fakeControllerInstances].map((instanceId) => ({ instanceId, environmentId: "env_1" })),
  stopInstance: async (instanceId: string) => {
    if (controllerStopErrorId === instanceId) throw new Error(`controller stop failed for ${instanceId}`);
    if (!fakeControllerInstances.has(instanceId)) throw new Error(`Instance '${instanceId}' not found`);
    fakeControllerInstances.delete(instanceId);
  },
} as unknown as AgentController;

/** 注册一个属于指定 org 的 running supplement（真实注册表单例）。 */
function registerRunningInstance(instanceId: string, environmentId: string, organizationId: string): void {
  globalInstanceRegistry.register(instanceId, {
    userId: "user-1",
    environmentId,
    organizationId,
    spawnSource: "interactive",
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: null,
  });
}

/** stubDb：agent row 查询 + 绑定 envIds 查询 + 事务删除（返回 agent_config 删除结果）。 */
function stubDbForDelete(envIds: string[]): void {
  stubDb({
    select: (projection?: unknown) => {
      if (projection) {
        // 有投影：deleteAgentConfig 删除前收集绑定 envIds
        return { from: () => ({ where: async () => envIds.map((id) => ({ id })) }) };
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
          where: () => ({
            returning: async () => [{ id: AGENT_ROW.id }],
          }),
        }),
      }),
  });
}

describe("deleteAgentConfig 停止绑定环境的运行实例", () => {
  beforeEach(() => {
    resetAllStubs();
    globalInstanceRegistry.clear();
    fakeControllerInstances.clear();
    controllerStopErrorId = null;
    stopCalls = [];
    resetOrchestrationInstanceDeps();
    // helper 三路收集依赖 getCoreRuntime / getOrchestrationController，必须注入 fake，
    // 否则 preload mock 未配置时 getCoreRuntime 返回 undefined → listInstances 抛 TypeError
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    setOrchestrationInstanceDeps({
      getOrchestrationController: () => fakeController,
      reclaimYjsDocs: async () => {},
    });
    _resetDeps();
    stubResourcePermissionRepo({
      listOwnedByOrganization: async () => [],
    });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    fakeControllerInstances.clear();
    resetOrchestrationInstanceDeps();
    resetAllStubs();
  });

  async function callDeleteAgentConfig() {
    const { deleteAgentConfig } = await import("../services/config/agent-config");
    return deleteAgentConfig({ organizationId: ORG_1, userId: "user-1", role: "owner" }, "demo-agent");
  }

  // 核心场景：删除 agent 时停止其绑定 env 下的全部 running 实例——registry supplement、
  // controller 活跃表、core 进程三侧都被清理，DB 删除仍成功
  test("删除 agent 停止其全部绑定 env 的运行实例", async () => {
    registerRunningInstance("inst_1", "env_1", ORG_1);
    registerRunningInstance("inst_2", "env_2", ORG_1);
    fakeControllerInstances.add("inst_1").add("inst_2");
    stubDbForDelete(["env_1", "env_2"]);

    const deleted = await callDeleteAgentConfig();

    expect(deleted).toBe(true);
    expect(globalInstanceRegistry.getByEnvironment("env_1")).toEqual([]);
    expect(globalInstanceRegistry.getByEnvironment("env_2")).toEqual([]);
    expect(fakeControllerInstances.size).toBe(0);
    expect([...stopCalls].sort()).toEqual(["inst_1", "inst_2"]);
  });

  // 单个实例 controller 层 stop 失败（stopInstanceViaController 吞错并继续三侧清理）
  // 不阻断删除：DB 行仍删除、其余实例仍被 stop、返回 true
  test("单个实例 stop 失败不中断删除，其余实例仍被清理", async () => {
    registerRunningInstance("inst_ok", "env_1", ORG_1);
    registerRunningInstance("inst_fail", "env_1", ORG_1);
    fakeControllerInstances.add("inst_ok").add("inst_fail");
    controllerStopErrorId = "inst_fail";
    stubDbForDelete(["env_1"]);

    const deleted = await callDeleteAgentConfig();

    expect(deleted).toBe(true);
    // 失败实例的 supplement 同样被清理：stopInstanceViaController 对 controller 层
    // 错误吞错后继续 facade.stopInstance + unregister，三侧收敛不因单点失败中断
    expect(globalInstanceRegistry.getByEnvironment("env_1")).toEqual([]);
    expect([...stopCalls].sort()).toEqual(["inst_fail", "inst_ok"]);
    // controller 活跃表残留的是模拟失败的 inst_fail（真实实现 stop 目标不存在才抛错）
    expect(fakeControllerInstances.has("inst_fail")).toBe(true);
    expect(fakeControllerInstances.has("inst_ok")).toBe(false);
  });

  // stop 全部失败（core runtime 不可用，stopInstanceViaController 在 try 外抛错）时
  // 删除仍继续：DB 行删除、返回 true，残留实例由 idle monitor / 超时兜底
  test("stop 全部失败时删除仍成功且不抛错", async () => {
    registerRunningInstance("inst_1", "env_1", ORG_1);
    fakeControllerInstances.add("inst_1");
    let coreRuntimeCalls = 0;
    // 第 1 次（helper 收集）成功，第 2 次起（stopInstanceViaController 内 getCoreRuntime）抛错
    stubCoreBootstrap({
      getCoreRuntime: () => {
        coreRuntimeCalls += 1;
        if (coreRuntimeCalls > 1) throw new Error("core runtime unavailable");
        return fakeFacade;
      },
    });
    stubDbForDelete(["env_1"]);

    const deleted = await callDeleteAgentConfig();

    expect(deleted).toBe(true);
    // stop 失败：facade.stopInstance 未执行、supplement 未清理（残留由兜底回收）
    expect(stopCalls).toEqual([]);
    expect(globalInstanceRegistry.getByEnvironment("env_1").length).toBe(1);
  });

  // 回归原行为：无运行实例时删除照常成功，helper 为幂等 no-op
  test("无运行实例时删除照常成功", async () => {
    stubDbForDelete(["env_1"]);

    const deleted = await callDeleteAgentConfig();

    expect(deleted).toBe(true);
    expect(stopCalls).toEqual([]);
    expect(globalInstanceRegistry.getByEnvironment("env_1")).toEqual([]);
  });

  // 多租户隔离：仅 stop 归属当前组织的实例，跨组织实例的 supplement 与活跃表保留
  test("跨组织实例不被误停", async () => {
    registerRunningInstance("inst_own", "env_1", ORG_1);
    registerRunningInstance("inst_other", "env_1", ORG_2);
    fakeControllerInstances.add("inst_own").add("inst_other");
    stubDbForDelete(["env_1"]);

    const deleted = await callDeleteAgentConfig();

    expect(deleted).toBe(true);
    // 仅 inst_own 被清理；inst_other 的 supplement 与活跃表保留
    expect(globalInstanceRegistry.get("inst_own")).toBeUndefined();
    expect(globalInstanceRegistry.get("inst_other")).toBeDefined();
    expect(stopCalls).toEqual(["inst_own"]);
    expect(fakeControllerInstances.has("inst_own")).toBe(false);
    expect(fakeControllerInstances.has("inst_other")).toBe(true);
  });
});
