/**
 * connectAgentRelay 死亡钩子测试 — 连接失败触发本地实例清理（C-P2.4）。
 *
 * 背景：ensureRunning 按 core 快照 status==="running" 复用实例，本地进程死后
 * 快照恒 running，connectAgentRelay 每次失败而实例永不回收（前端 1011 重连
 * 死循环、配额被死实例占用）。本测试验证 connectAgentRelay 失败路径对本地
 * running/error 实例触发 terminateLocalDeadInstance，远程/非运行实例不误伤。
 *
 * 通过 stubCoreBootstrap + setOrchestrationInstanceDeps 注入 fake facade /
 * fake controller；terminateLocalDeadInstance 为 fire-and-forget，断言前用
 * setTimeout(0) 等其微任务链完成。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade, RuntimeInstanceSnapshot } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import { resetOrchestrationInstanceDeps, setOrchestrationInstanceDeps } from "../services/orchestration-instance";
import { resetAllStubs, stubCoreBootstrap } from "../test-utils/helpers";
import { connectAgentRelay } from "../transport/agent-relay";

const INSTANCE_ID = "inst-1";

/** 记录 controller.stopInstance 调用（清理触发的证据）。 */
const controllerStopCalls: string[] = [];
/** connectInstanceRelay 的行为：抛错 / 返回正常 handle / 返回 ready reject 的 handle。 */
type ConnectBehavior = "throw" | "ok" | "ready-reject";
let connectBehavior: ConnectBehavior = "ok";
/** facade.getInstance 返回的 core 快照。 */
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
  listInstances: () => [{ instanceId: INSTANCE_ID }],
  stopInstance: async (instanceId: string) => {
    controllerStopCalls.push(instanceId);
  },
} as unknown as AgentController;

const fakeFacade = {
  getInstance: () => snapshot,
  connectInstanceRelay: async () => {
    if (connectBehavior === "throw") throw new Error("relay connect failed");
    if (connectBehavior === "ready-reject") {
      return { state: "open", send() {}, close() {}, ready: Promise.reject(new Error("closed before open")) };
    }
    return { state: "open", send() {}, close() {} };
  },
  stopInstance: async () => {},
} as unknown as CoreRuntimeFacade;

/** 等待 fire-and-forget 清理链完成（微任务 + macrotask 边界）。 */
async function flushCleanup(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("connectAgentRelay death hook", () => {
  beforeEach(() => {
    controllerStopCalls.length = 0;
    connectBehavior = "ok";
    snapshot = makeSnapshot();
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    setOrchestrationInstanceDeps({ getOrchestrationController: () => fakeController });
  });

  afterEach(() => {
    resetOrchestrationInstanceDeps();
    resetAllStubs();
  });

  // 本地实例进程已死（connectInstanceRelay 抛错）且快照仍 running：
  // 必须触发实例级清理，下一次 ensureRunning 才能重新 spawn 而非复用死实例
  test("connectInstanceRelay 抛错且本地 running 实例 → 触发清理且原错误抛出", async () => {
    connectBehavior = "throw";

    await expect(connectAgentRelay(INSTANCE_ID, "ses-1")).rejects.toThrow("relay connect failed");
    await flushCleanup();

    expect(controllerStopCalls).toEqual([INSTANCE_ID]);
  });

  // 远程实例由 E-P0.1 机器级清理覆盖，连接失败不得触发本地死亡钩子
  test("connectInstanceRelay 抛错且远程实例 → 不触发清理", async () => {
    connectBehavior = "throw";
    snapshot = makeSnapshot({ nodeId: "mach_remote" });

    await expect(connectAgentRelay(INSTANCE_ID, "ses-1")).rejects.toThrow("relay connect failed");
    await flushCleanup();

    expect(controllerStopCalls).toEqual([]);
  });

  // 非 running 状态（如 stopped）不是"死亡"，可能处于正常停止流程，不得误清理
  test("connectInstanceRelay 抛错且本地实例非 running → 不触发清理", async () => {
    connectBehavior = "throw";
    snapshot = makeSnapshot({ status: "stopped" });

    await expect(connectAgentRelay(INSTANCE_ID, "ses-1")).rejects.toThrow("relay connect failed");
    await flushCleanup();

    expect(controllerStopCalls).toEqual([]);
  });

  // WS 建立前关闭（ready reject）同样是"无法建立 relay"，必须走同一死亡清理路径
  test("ready reject（WS 建立前关闭）→ 同样触发清理", async () => {
    connectBehavior = "ready-reject";

    await expect(connectAgentRelay(INSTANCE_ID, "ses-1")).rejects.toThrow("closed before open");
    await flushCleanup();

    expect(controllerStopCalls).toEqual([INSTANCE_ID]);
  });

  // 成功路径回归：正常返回 handle，不得触发任何清理副作用
  test("连接成功 → 正常返回 handle，无副作用", async () => {
    connectBehavior = "ok";

    const handle: EngineRelayHandle = await connectAgentRelay(INSTANCE_ID, "ses-1");
    await flushCleanup();

    expect(handle.state).toBe("open");
    expect(controllerStopCalls).toEqual([]);
  });
});
