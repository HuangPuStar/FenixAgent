/**
 * 删除 Agent 前停止其绑定 Environment 上运行实例的测试（C-R1 修复验证，S4 接缝迁移）。
 *
 * 背景：删除 agent_config 只删 DB 行，其绑定 environment 上正在运行的编排实例
 * （Agent 进程 + controller 活跃表 + registry supplement + 并发额度）会残留为资源
 * 泄漏，idle monitor 对 interactive 永不回收（见
 * docs/issues/2026-08-19-agent-delete-instance-leak.md）。修复后删除路径在 DB 事务前调用
 * stopInstancesForEnvironments 主动停止实例。
 *
 * 接缝说明：该编排已经收敛到 `AgentConfigFacade.remove`（授权 → 收集绑定 env → 停实例 → 删行），
 * 因此用例用**真实 Facade** + 领域服务替身驱动，而不是替换 Facade：停实例是 Facade 自身的行为，
 * 换成替身就没有覆盖了。申请"停止运行实例"的调用对象仍是真实实现，通过既有 seam 注入：
 *   - globalInstanceRegistry 为真实单例，beforeEach 清空、用例内注册 supplement；
 *   - core-bootstrap 通过 stubCoreBootstrap 注入 fakeFacade（listInstances 空 +
 *     记录 stopInstance 调用）；
 *   - orchestration-instance 通过 setOrchestrationInstanceDeps 注入 fakeController
 *     （活跃表可操控）与 reclaimYjsDocs spy（避免动态 import relay）。
 *
 * 领域服务替身只表达"这个 Agent 存在、绑定这些 env、删除成功"，授权由全放行的授权替身承担。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  globalInstanceRegistry,
  resetOrchestrationInstanceDeps,
  setOrchestrationInstanceDeps,
} from "@fenix/agent-runtime/server";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { resetAllStubs, stubCoreBootstrap } from "@server/test-utils/helpers";
import { agentConfigResource } from "../server/access/agent-config-resource";
import { AgentConfigFacade } from "../server/facades/agent-config-facade";
import { createStubAgentConfigService } from "../server/testing";
import { createFakeAccessControl, createRecordingScopeStore, scopedAgent, testActor } from "./fixtures";

const ORG_1 = "org-1";
const ORG_2 = "org-2";
const AGENT_ID = "agc_1";
const AGENT_NAME = "demo-agent";

/** 记录 facade.stopInstance 调用（stopInstanceViaController 的 core 侧）。 */
let stopCalls: string[] = [];
/** 编排域 fake controller 活跃表。 */
const fakeControllerInstances = new Set<string>();
/** 非 null 时 fake controller 对该 id 抛错（模拟 controller 层停止失败）。 */
let controllerStopErrorId: string | null = null;
/** 删除路径最终落到领域服务 `remove` 的入参；非空即代表 DB 删除步骤被执行。 */
let removedInputs: Array<{ resourceId: string; organizationId: string }> = [];

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

/** 装配真实 Facade：授权全放行，领域服务替身表达"Agent 存在 + 绑定这些 env + 删除成功"。 */
async function removeAgentConfig(envIds: string[]): Promise<void> {
  const { store } = createRecordingScopeStore();
  const facade = new AgentConfigFacade(
    createStubAgentConfigService({
      findByName: async ({ name }) => scopedAgent({ id: AGENT_ID, organizationId: ORG_1, name }),
      listBoundEnvironmentIds: async () => envIds,
      remove: async (input) => {
        removedInputs.push(input);
        return true;
      },
    }),
    {
      accessControl: createFakeAccessControl(),
      resource: agentConfigResource.definition,
      scopeStore: store,
    },
  );
  await facade.remove(testActor(), AGENT_NAME);
}

describe("deleteAgentConfig 停止绑定环境的运行实例", () => {
  beforeEach(() => {
    resetAllStubs();
    globalInstanceRegistry.clear();
    fakeControllerInstances.clear();
    controllerStopErrorId = null;
    stopCalls = [];
    removedInputs = [];
    resetOrchestrationInstanceDeps();
    // 删除路径的实例停止依赖 getCoreRuntime / getOrchestrationController，必须注入 fake，
    // 否则 preload mock 未配置时 getCoreRuntime 返回 undefined → listInstances 抛 TypeError
    // （同 workflow-cleanup.test.ts 的教训）。
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    setOrchestrationInstanceDeps({
      getOrchestrationController: () => fakeController,
      reclaimYjsDocs: async () => {},
    });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    fakeControllerInstances.clear();
    resetOrchestrationInstanceDeps();
    resetAllStubs();
  });

  // 核心场景：删除 agent 时停止其绑定 env 下的全部 running 实例——registry supplement、
  // controller 活跃表、core 进程三侧都被清理，DB 删除仍成功
  test("删除 agent 停止其全部绑定 env 的运行实例", async () => {
    registerRunningInstance("inst_1", "env_1", ORG_1);
    registerRunningInstance("inst_2", "env_2", ORG_1);
    fakeControllerInstances.add("inst_1").add("inst_2");

    await removeAgentConfig(["env_1", "env_2"]);

    expect(removedInputs).toEqual([{ resourceId: AGENT_ID, organizationId: ORG_1 }]);
    expect(globalInstanceRegistry.getByEnvironment("env_1")).toEqual([]);
    expect(globalInstanceRegistry.getByEnvironment("env_2")).toEqual([]);
    expect(fakeControllerInstances.size).toBe(0);
    expect([...stopCalls].sort()).toEqual(["inst_1", "inst_2"]);
  });

  // 单个实例 controller 层 stop 失败（stopInstanceViaController 吞错并继续三侧清理）
  // 不阻断删除：DB 行仍删除、其余实例仍被 stop
  test("单个实例 stop 失败不中断删除，其余实例仍被清理", async () => {
    registerRunningInstance("inst_ok", "env_1", ORG_1);
    registerRunningInstance("inst_fail", "env_1", ORG_1);
    fakeControllerInstances.add("inst_ok").add("inst_fail");
    controllerStopErrorId = "inst_fail";

    await removeAgentConfig(["env_1"]);

    expect(removedInputs).toEqual([{ resourceId: AGENT_ID, organizationId: ORG_1 }]);
    // 失败实例的 supplement 同样被清理：stopInstanceViaController 对 controller 层
    // 错误吞错后继续 facade.stopInstance + unregister，三侧收敛不因单点失败中断
    expect(globalInstanceRegistry.getByEnvironment("env_1")).toEqual([]);
    expect([...stopCalls].sort()).toEqual(["inst_fail", "inst_ok"]);
    // controller 活跃表残留的是模拟失败的 inst_fail（真实实现 stop 目标不存在才抛错）
    expect(fakeControllerInstances.has("inst_fail")).toBe(true);
    expect(fakeControllerInstances.has("inst_ok")).toBe(false);
  });

  // stop 全部失败（core runtime 不可用，stopInstanceViaController 在 try 外抛错）时
  // 删除仍继续：DB 行删除，残留实例由 idle monitor / 超时兜底
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

    await removeAgentConfig(["env_1"]);

    // 删除未被 stop 失败阻断：DB 删除步骤（service.remove）照常执行
    expect(removedInputs).toEqual([{ resourceId: AGENT_ID, organizationId: ORG_1 }]);
    // stop 失败：facade.stopInstance 未执行、supplement 未清理（残留由兜底回收）
    expect(stopCalls).toEqual([]);
    expect(globalInstanceRegistry.getByEnvironment("env_1").length).toBe(1);
  });

  // 回归原行为：无运行实例时删除照常成功，helper 为幂等 no-op
  test("无运行实例时删除照常成功", async () => {
    await removeAgentConfig(["env_1"]);

    expect(removedInputs).toEqual([{ resourceId: AGENT_ID, organizationId: ORG_1 }]);
    expect(stopCalls).toEqual([]);
    expect(globalInstanceRegistry.getByEnvironment("env_1")).toEqual([]);
  });

  // 多租户隔离：仅 stop 归属当前组织的实例，跨组织实例的 supplement 与活跃表保留
  test("跨组织实例不被误停", async () => {
    registerRunningInstance("inst_own", "env_1", ORG_1);
    registerRunningInstance("inst_other", "env_1", ORG_2);
    fakeControllerInstances.add("inst_own").add("inst_other");

    await removeAgentConfig(["env_1"]);

    expect(removedInputs).toEqual([{ resourceId: AGENT_ID, organizationId: ORG_1 }]);
    // 仅 inst_own 被清理；inst_other 的 supplement 与活跃表保留
    expect(globalInstanceRegistry.get("inst_own")).toBeUndefined();
    expect(globalInstanceRegistry.get("inst_other")).toBeDefined();
    expect(stopCalls).toEqual(["inst_own"]);
    expect(fakeControllerInstances.has("inst_own")).toBe(false);
    expect(fakeControllerInstances.has("inst_other")).toBe(true);
  });
});
