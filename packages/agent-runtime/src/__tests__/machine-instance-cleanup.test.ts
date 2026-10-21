/**
 * 机器维度实例收敛（`AgentRuntimePort.cleanupMachineInstances` 的实现）测试。
 *
 * 覆盖本函数自己负责的两件事：①只删目标机器的 core 实例、且每个删除都配对注销实例登记表；
 * ②core 侧已无实例时仍要收敛编排域活跃表（调用方是宿主的机器重连/断连/沙盒释放路径，
 * 后者不经 ACP handler，E-P0.1）。core 单例经包内 `../server/testing` 的 `stubCoreRuntimeFacade`
 * 注入假 facade，与包内其它用例的接缝一致。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { WEBSOCKET_CODES } from "acp-link/websocket-code";
import { agentInstanceService } from "../server/services/agent-instance-service";
import { stubCoreRuntimeFacade } from "../server/testing";
import {
  bindRelayLifecyclePort,
  resetRelayLifecyclePort,
  tryGetRelayLifecyclePort,
} from "../server/transport/relay/lifecycle-port";
import { globalInstanceRegistry } from "../services/instance-registry";
import { convergeMachineInstances } from "../services/machine-instance-cleanup";
import {
  resetOrchestrationMachineCleanupDeps,
  setOrchestrationMachineCleanupDeps,
} from "../services/orchestration-machine-cleanup";

/** 只实现收敛用到的两个动词的假 facade：实例列表可控，删除记录到数组。 */
function fakeFacadeWith(instances: Array<{ instanceId: string; nodeId: string }>): {
  facade: CoreRuntimeFacade;
  deleted: string[];
} {
  const deleted: string[] = [];
  const facade = {
    listInstances: () => instances,
    deleteInstance: (instanceId: string) => {
      deleted.push(instanceId);
      return true;
    },
  } as unknown as CoreRuntimeFacade;
  return { facade, deleted };
}

/** 登记表条目只用于断言「被删实例的补充信息一并注销」，字段取最小可用集。 */
function registerSupplement(instanceId: string, environmentId: string): void {
  globalInstanceRegistry.register(instanceId, {
    environmentId,
    agentConfigId: null,
    userId: "user-1",
    organizationId: "org-1",
    instanceName: instanceId,
    spawnSource: "interactive",
    relayCount: 0,
    lastActivityAt: Date.now(),
    lastRelayDetachedAt: null,
    createdAt: Date.now(),
  } as Parameters<typeof globalInstanceRegistry.register>[1]);
}

describe("convergeMachineInstances", () => {
  // Relay 绑定的默认值来自 chat-channel 装配模块的副作用；resetting 成 null 会让同进程
  // 后续用例误走「未绑定」分支，因此这里保存并在用例结束后还原。
  let previousRelayPort: ReturnType<typeof tryGetRelayLifecyclePort> = null;

  beforeEach(() => {
    globalInstanceRegistry.clear();
    previousRelayPort = tryGetRelayLifecyclePort();
  });

  afterEach(() => {
    // 机器清理函数经编排域收敛无条件调用编排单例，用例结束必须复位，避免活跃表状态跨文件泄漏
    resetOrchestrationMachineCleanupDeps();
    globalInstanceRegistry.clear();
    if (previousRelayPort) bindRelayLifecyclePort(previousRelayPort);
    else resetRelayLifecyclePort();
    previousRelayPort = null;
    resetAllStubs();
  });

  // 只删目标机器的实例：别的机器上的实例与登记表条目必须原样保留，否则一次重连会连带清掉
  // 其它机器的运行时（并发额度与 relay 语义都会被误伤）
  test("只收敛目标机器的实例，其余机器的实例与登记表条目不受影响", () => {
    const { facade, deleted } = fakeFacadeWith([
      { instanceId: "inst-a", nodeId: "m1" },
      { instanceId: "inst-b", nodeId: "m1" },
      { instanceId: "inst-c", nodeId: "m2" },
    ]);
    stubCoreRuntimeFacade(facade);
    registerSupplement("inst-a", "env-1");
    registerSupplement("inst-c", "env-1");

    expect(convergeMachineInstances("m1")).toBe(2);

    expect(deleted).toEqual(["inst-a", "inst-b"]);
    // 登记表条目随删除配对注销：漏掉会让该实例永久计入环境并发额度
    expect(globalInstanceRegistry.has("inst-a")).toBe(false);
    expect(globalInstanceRegistry.has("inst-c")).toBe(true);
  });

  // core 侧已无实例（例如 idle 回收先一步收尾）时仍要清理编排域活跃表，返回 0 且不抛错：
  // 这是沙盒释放路径唯一能收敛幽灵实例的时机
  test("core 实例为空时仍收敛编排域并返回 0", () => {
    const { facade } = fakeFacadeWith([]);
    stubCoreRuntimeFacade(facade);
    const reclaimed: string[] = [];
    setOrchestrationMachineCleanupDeps({
      getOrchestrationController: () =>
        ({ stopInstancesByMachineId: () => ["inst-ghost"] }) as unknown as AgentController,
      reclaimYjsDocs: async (instanceId) => {
        reclaimed.push(instanceId);
      },
    });

    expect(convergeMachineInstances("m-ghost")).toBe(0);
    expect(reclaimed).toEqual(["inst-ghost"]);
  });

  // 无匹配实例且活跃表为空：幂等重入安全（重连分支每次都会调用本函数）
  test("无匹配实例时幂等返回 0", () => {
    const { facade } = fakeFacadeWith([{ instanceId: "inst-c", nodeId: "m2" }]);
    stubCoreRuntimeFacade(facade);

    expect(convergeMachineInstances("m1")).toBe(0);
    expect(convergeMachineInstances("m1")).toBe(0);
  });

  // VER-REVIEW-017：沙盒释放是确定终止，core 与编排域两路收集到的实例都必须上报，否则
  // 持久实例残留 running，下一次进入智能体会被跳过、沙盒不会按新配置重建。
  test("runtimeTerminated 时把两路实例一并上报运行态终止", () => {
    const { facade } = fakeFacadeWith([
      { instanceId: "inst-a", nodeId: "m1" },
      { instanceId: "inst-b", nodeId: "m1" },
    ]);
    stubCoreRuntimeFacade(facade);
    setOrchestrationMachineCleanupDeps({
      getOrchestrationController: () =>
        ({ stopInstancesByMachineId: () => ["inst-ghost"] }) as unknown as AgentController,
      reclaimYjsDocs: async () => {},
    });
    const captured: Array<{ machineId?: string; instanceUids?: readonly string[] }> = [];
    const spy = spyOn(agentInstanceService, "handleRuntimeTerminated").mockImplementation((input) => {
      captured.push(input);
      return [];
    });

    try {
      expect(convergeMachineInstances("m1", { runtimeTerminated: true })).toBe(2);
      expect(captured).toEqual([{ machineId: "m1", instanceUids: ["inst-a", "inst-b", "inst-ghost"] }]);
    } finally {
      spy.mockRestore();
    }
  });

  // 释放先于断连事件到达时 ACP handler 的清理收集不到实例 ID，前端 relay 连接只能由本路径
  // 关闭，否则客户端挂在已销毁的 runtime 上，重进智能体也拿不到新的实时流。
  test("runtimeTerminated 时关闭相关实例的前端 relay 连接", () => {
    const { facade } = fakeFacadeWith([
      { instanceId: "inst-a", nodeId: "m1" },
      { instanceId: "inst-b", nodeId: "m1" },
    ]);
    stubCoreRuntimeFacade(facade);
    setOrchestrationMachineCleanupDeps({
      getOrchestrationController: () =>
        ({ stopInstancesByMachineId: () => ["inst-ghost"] }) as unknown as AgentController,
      reclaimYjsDocs: async () => {},
    });
    const closed: Array<[string, number, string]> = [];
    bindRelayLifecyclePort({
      closeClientsByInstance: (instanceId, code, reason) => {
        closed.push([instanceId, code, reason]);
      },
      reclaimInstanceRealtimeResources: async () => {},
      closeAllClients: () => {},
    });
    const spy = spyOn(agentInstanceService, "handleRuntimeTerminated").mockImplementation(() => []);

    try {
      convergeMachineInstances("m1", { runtimeTerminated: true });
      const code = WEBSOCKET_CODES.MACHINE_UNAVAILABLE.code;
      expect(closed).toEqual([
        ["inst-a", code, "machine unavailable"],
        ["inst-b", code, "machine unavailable"],
        ["inst-ghost", code, "machine unavailable"],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  // 断连/重连路径可能仍有远端进程存活，不能把实例报告为已终止，否则会在旧进程未退出时
  // 启动第二个 runtime；前端连接同理必须保留，等待机器重连恢复。
  test("未标记确定终止时不上报运行态终止也不关闭前端连接", () => {
    const { facade } = fakeFacadeWith([{ instanceId: "inst-a", nodeId: "m1" }]);
    stubCoreRuntimeFacade(facade);
    const closed: string[] = [];
    bindRelayLifecyclePort({
      closeClientsByInstance: (instanceId) => {
        closed.push(instanceId);
      },
      reclaimInstanceRealtimeResources: async () => {},
      closeAllClients: () => {},
    });
    const spy = spyOn(agentInstanceService, "handleRuntimeTerminated").mockImplementation(() => []);

    try {
      expect(convergeMachineInstances("m1")).toBe(1);
      expect(spy).not.toHaveBeenCalled();
      expect(closed).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
