/**
 * terminateLocalDeadInstance 测试 — 本地实例死亡清理（C-P2.4）。
 *
 * 背景：local-default 节点是 N:1 共享节点（stub socket 恒 connected），实例状态
 * 由节点状态推导，本地进程崩溃后 core 快照永远停留在 running，死实例被
 * ensureRunning 无限复用且持续占用并发额度（error 状态还被 idle monitor 默认
 * sweep 排除，成为永久泄漏路径）。terminateLocalDeadInstance 是远程机器断连
 * 清理的本地对应物，按实例粒度（而非节点粒度）清理已确认死亡的本地实例。
 *
 * 本测试通过 stubCoreBootstrap + setOrchestrationInstanceDeps 注入 fake facade /
 * fake controller，验证前置校验（nodeId / 状态 / 活跃表）、幂等与 fire-and-forget
 * 语义；不 mock 模块。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade, RuntimeInstanceSnapshot } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import {
  resetOrchestrationInstanceDeps,
  setOrchestrationInstanceDeps,
  terminateLocalDeadInstance,
} from "../services/orchestration-instance";
import { resetAllStubs, stubCoreBootstrap } from "../test-utils/helpers";

const INSTANCE_ID = "inst-1";

/** 记录 controller.stopInstance 调用；仅此一处状态被假 controller 修改。 */
const controllerStopCalls: string[] = [];
/** 记录 facade.stopInstance 调用。 */
const facadeStopCalls: string[] = [];
/** 记录实例停止完成点的 YJS Doc 回收调用（SP-C2 接线验证）。 */
const yjsReclaimCalls: string[] = [];
/** 每次回收触发时刻的 facade 停止调用数（顺序钉住：回收必须在 core 停止之后）。 */
const facadeStopCountAtReclaim: number[] = [];
/** 当前注入的 controller.stopInstance 实现（测试 7 用于挂起第一个调用）。 */
let controllerStopImpl: (instanceId: string) => Promise<void> = async (id) => {
  controllerStopCalls.push(id);
};
/** controller.listInstances 返回的活跃表；测试按需替换。 */
let activeInstances: string[] = [];
/** facade.getInstance 返回的 core 快照；测试按需替换。 */
let snapshot: RuntimeInstanceSnapshot | null = null;

/** 构造 core 快照（默认 local-default + running）。 */
function makeSnapshot(overrides: Partial<RuntimeInstanceSnapshot> = {}): RuntimeInstanceSnapshot {
  return {
    instanceId: INSTANCE_ID,
    engineType: "opencode",
    nodeId: "local-default",
    status: "running",
    launchSpec: {} as RuntimeInstanceSnapshot["launchSpec"],
    relayConnected: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as RuntimeInstanceSnapshot;
}

const fakeController = {
  listInstances: () => activeInstances.map((instanceId) => ({ instanceId })),
  stopInstance: (instanceId: string) => controllerStopImpl(instanceId),
} as unknown as AgentController;

const fakeFacade = {
  getInstance: () => snapshot,
  stopInstance: async (instanceId: string) => {
    facadeStopCalls.push(instanceId);
  },
} as unknown as CoreRuntimeFacade;

describe("terminateLocalDeadInstance", () => {
  beforeEach(() => {
    controllerStopCalls.length = 0;
    facadeStopCalls.length = 0;
    yjsReclaimCalls.length = 0;
    facadeStopCountAtReclaim.length = 0;
    activeInstances = [INSTANCE_ID];
    snapshot = makeSnapshot();
    controllerStopImpl = async (id) => {
      controllerStopCalls.push(id);
    };
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    setOrchestrationInstanceDeps({
      getOrchestrationController: () => fakeController,
      // 隔离 SP-C2 回收接线：默认实现会惰性装配真实 ChatChannelController，
      // 本文件的既有用例只验证停止语义，不依赖真实 Doc 回收
      reclaimYjsDocs: async (instanceId) => {
        yjsReclaimCalls.push(instanceId);
        facadeStopCountAtReclaim.push(facadeStopCalls.length);
      },
    });
  });

  afterEach(() => {
    resetOrchestrationInstanceDeps();
    resetAllStubs();
  });

  // 本地实例 running 且活跃表存在：死亡信号应触发完整清理
  // （controller 活跃表移除 + core stopInstance），死实例不再占坑
  test("本地实例运行中且活跃表存在 → controller stop 与 core stopInstance 均被调用", async () => {
    await terminateLocalDeadInstance(INSTANCE_ID);

    expect(controllerStopCalls).toEqual([INSTANCE_ID]);
    expect(facadeStopCalls).toEqual([INSTANCE_ID]);
  });

  // 远程实例由 E-P0.1 机器级断连清理覆盖，本地死亡钩子必须静默跳过，避免双重清理
  test("远程实例（nodeId=mach_xxx）→ 静默跳过，不清理", async () => {
    snapshot = makeSnapshot({ nodeId: "mach_remote" });

    await terminateLocalDeadInstance(INSTANCE_ID);

    expect(controllerStopCalls).toEqual([]);
    expect(facadeStopCalls).toEqual([]);
  });

  // core 无快照（实例已被外部清理）时无法确认归属，静默跳过
  test("core 无快照 → 静默跳过", async () => {
    snapshot = null;

    await terminateLocalDeadInstance(INSTANCE_ID);

    expect(controllerStopCalls).toEqual([]);
    expect(facadeStopCalls).toEqual([]);
  });

  // stopped/stopping 为正常终止路径的状态，不构成"死亡"，不得重复 stop
  test("快照状态为 stopped/stopping → 静默跳过", async () => {
    snapshot = makeSnapshot({ status: "stopped" });
    await terminateLocalDeadInstance(INSTANCE_ID);
    expect(controllerStopCalls).toEqual([]);

    snapshot = makeSnapshot({ status: "stopping" });
    await terminateLocalDeadInstance(INSTANCE_ID);
    expect(controllerStopCalls).toEqual([]);
    expect(facadeStopCalls).toEqual([]);
  });

  // error 状态是 connectRelay 失败被 markInstanceError 的实例，idle monitor 默认
  // sweep 排除该状态（唯一永久泄漏路径），必须照常清理（C-P2.4 钉住）
  test("快照状态为 error（connectRelay 失败场景）→ 照常清理", async () => {
    snapshot = makeSnapshot({ status: "error" });

    await terminateLocalDeadInstance(INSTANCE_ID);

    expect(controllerStopCalls).toEqual([INSTANCE_ID]);
    expect(facadeStopCalls).toEqual([INSTANCE_ID]);
  });

  // 实例已不在编排域活跃表（已被 stop/清理）时跳过，避免重复 stop 的噪音日志
  test("实例不在编排域活跃表（已被 stop/清理）→ 静默跳过，不产生重复 stop", async () => {
    activeInstances = [];

    await terminateLocalDeadInstance(INSTANCE_ID);

    expect(controllerStopCalls).toEqual([]);
    expect(facadeStopCalls).toEqual([]);
  });

  // 并发死亡信号（yjs + workflow 同 handle 同时触发）只清理一次：in-flight 去重
  test("并发重复调用同一实例 → 只执行一次 stopInstanceViaController", async () => {
    const stopResolvers: Array<() => void> = [];
    controllerStopImpl = (id) => {
      controllerStopCalls.push(id);
      return new Promise<void>((resolve) => {
        stopResolvers.push(resolve);
      });
    };

    const p1 = terminateLocalDeadInstance(INSTANCE_ID);
    const p2 = terminateLocalDeadInstance(INSTANCE_ID);

    // 两个调用都已同步进入：第一个已入 in-flight 集合并挂起在 stop，第二个被去重拦截
    expect(controllerStopCalls).toHaveLength(1);
    stopResolvers[0]?.();
    await Promise.all([p1, p2]);

    expect(controllerStopCalls).toHaveLength(1);
    expect(facadeStopCalls).toHaveLength(1);
  });

  // fire-and-forget 语义：校验/清理过程中的任何异常都不得向上传播，
  // 失败实例留给 idle monitor 兜底
  test("stopInstanceViaController 抛错 → 不向上抛（fire-and-forget）", async () => {
    setOrchestrationInstanceDeps({
      getOrchestrationController: () => {
        throw new Error("controller down");
      },
    });

    await expect(terminateLocalDeadInstance(INSTANCE_ID)).resolves.toBeUndefined();
  });

  // SP-C2：实例停止完成点必须触发内存 YJS Doc 回收（idle reclaim 4001 路径与
  // 死实例清理共用 stopInstanceViaController funnel），且回收发生在 core 停止之后——
  // 实例可能存活时关 Doc 会丢弃实时流（C6 断链语义一）。
  test("停止完成 → 触发 yjs doc 回收，且顺序在 core stop 之后", async () => {
    await terminateLocalDeadInstance(INSTANCE_ID);

    expect(controllerStopCalls).toEqual([INSTANCE_ID]);
    expect(facadeStopCalls).toEqual([INSTANCE_ID]);
    expect(yjsReclaimCalls).toEqual([INSTANCE_ID]);
    // 回收触发时 core 停止已完成（顺序钉住）
    expect(facadeStopCountAtReclaim).toEqual([1]);
  });
});
