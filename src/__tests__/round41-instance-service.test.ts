import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade, RuntimeInstanceSnapshot } from "@fenix/core";
import { AppError, NotFoundError } from "../errors";
import {
  ensureRunning,
  enterEnvironment,
  findRunningInstanceByEnvironment,
  getInstance,
  getRunningInstancesByEnvironment,
  groupActiveInstancesByEnvironment,
  listInstances,
  listInstancesByEnvironment,
  listInstancesResponse,
  stopAllInstances,
  stopInstance,
  toInstanceActivityInfo,
  toInstanceInfo,
} from "../services/instance";
import { globalInstanceRegistry } from "../services/instance-registry";
import { resetOrchestrationBootstrap } from "../services/orchestration-bootstrap";
import { resetAllStubs, stubCoreBootstrap, stubEnvironmentRepo } from "../test-utils/helpers";
import type { InstanceSupplement } from "../types/store";

const ORG_A = "org-a";
const ORG_B = "org-b";
const ENV_A = "env-a";
const ENV_B = "env-b";

let snapshots: RuntimeInstanceSnapshot[] = [];
let stoppedIds: string[] = [];

function register(instanceId: string, overrides: Partial<InstanceSupplement> = {}): void {
  globalInstanceRegistry.register(instanceId, {
    userId: "user-a",
    environmentId: ENV_A,
    instanceNumber: 1,
    organizationId: ORG_A,
    spawnSource: "scheduled",
    lastActivityAt: 1_000,
    relayCount: 0,
    lastRelayDetachedAt: 1_000,
    ...overrides,
  });
}

function snapshot(
  instanceId: string,
  status: RuntimeInstanceSnapshot["status"] = "running",
  overrides: Partial<RuntimeInstanceSnapshot> = {},
): RuntimeInstanceSnapshot {
  return {
    instanceId,
    status,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    updatedAt: new Date("2026-01-02T03:04:06.000Z"),
    pluginMetadata: { port: 3100, pid: 42, token: "test-token" },
    ...overrides,
  } as RuntimeInstanceSnapshot;
}

function fakeFacade(): CoreRuntimeFacade {
  return {
    listInstances: () => snapshots,
    getInstance: (instanceId: string) => snapshots.find((item) => item.instanceId === instanceId),
    stopInstance: async (instanceId: string) => {
      stoppedIds.push(instanceId);
    },
  } as unknown as CoreRuntimeFacade;
}

describe("round41 instance service", () => {
  beforeEach(() => {
    snapshots = [];
    stoppedIds = [];
    globalInstanceRegistry.clear();
    resetAllStubs();
    resetOrchestrationBootstrap();
    stubCoreBootstrap({ getCoreRuntime: fakeFacade });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    resetOrchestrationBootstrap();
    resetAllStubs();
  });

  // 运行中快照应保留 core 元数据并合并业务 supplement。
  test("组织实例查询映射运行状态和运行时元数据", () => {
    register("inst-1");
    snapshots = [snapshot("inst-1")];

    expect(listInstances(ORG_A)).toMatchObject([{ id: "inst-1", status: "running", port: 3100, pid: 42 }]);
  });

  // 组织列表不得暴露其他组织的实例。
  test("组织实例查询隔离其他组织", () => {
    register("inst-a", { organizationId: ORG_A });
    register("inst-b", { organizationId: ORG_B, environmentId: ENV_B });
    snapshots = [snapshot("inst-a"), snapshot("inst-b")];

    expect(listInstances(ORG_A).map((item) => item.id)).toEqual(["inst-a"]);
  });

  // 缺少 supplement 的 core 快照不能进入业务列表。
  test("组织实例查询忽略未登记的运行时快照", () => {
    snapshots = [snapshot("unregistered")];

    expect(listInstances(ORG_A)).toEqual([]);
  });

  // stopping 状态对外兼容为 stopped。
  test("实例查询将 stopping 状态转换为 stopped", () => {
    register("inst-stopping");
    snapshots = [snapshot("inst-stopping", "stopping")];

    expect(listInstances(ORG_A)[0]?.status).toBe("stopped");
  });

  // 未知 core 状态应保守映射为 starting。
  test("实例查询将初始化状态转换为 starting", () => {
    register("inst-created");
    snapshots = [snapshot("inst-created", "created")];

    expect(listInstances(ORG_A)[0]?.status).toBe("starting");
  });

  // 错误状态及错误原因需要透传给调用方。
  test("实例查询保留错误状态和错误消息", () => {
    register("inst-error");
    snapshots = [snapshot("inst-error", "error", { errorMessage: "launch failed" })];

    expect(listInstances(ORG_A)[0]).toMatchObject({ status: "error", error: "launch failed" });
  });

  // 运行实例查询可按用户进一步隔离。
  test("按环境查找运行实例时匹配指定用户", () => {
    register("inst-user-a", { userId: "user-a" });
    register("inst-user-b", { userId: "user-b" });
    snapshots = [snapshot("inst-user-a"), snapshot("inst-user-b")];

    expect(findRunningInstanceByEnvironment(ENV_A, "user-b")?.id).toBe("inst-user-b");
  });

  // 非 running 的同环境实例不能作为可复用目标。
  test("按环境查找运行实例时排除 starting 实例", () => {
    register("inst-starting");
    snapshots = [snapshot("inst-starting", "starting")];

    expect(findRunningInstanceByEnvironment(ENV_A)).toBeUndefined();
  });

  // 环境列表仅保留仍活跃的 starting 或 running 实例。
  test("环境实例列表排除已停止和错误实例", () => {
    register("inst-running");
    register("inst-stopped", { instanceNumber: 2 });
    register("inst-error", { instanceNumber: 3 });
    snapshots = [snapshot("inst-running"), snapshot("inst-stopped", "stopped"), snapshot("inst-error", "error")];

    expect(listInstancesByEnvironment(ENV_A).map((item) => item.id)).toEqual(["inst-running"]);
  });

  // 运行实例列表只返回 running 状态。
  test("环境运行实例列表排除 starting 实例", () => {
    register("inst-running");
    register("inst-starting", { instanceNumber: 2 });
    snapshots = [snapshot("inst-running"), snapshot("inst-starting", "starting")];

    expect(getRunningInstancesByEnvironment(ENV_A).map((item) => item.id)).toEqual(["inst-running"]);
  });

  // 批量分组需要按环境聚合且过滤终态实例。
  test("活跃实例按环境分组并排除终态", () => {
    register("inst-a", { environmentId: ENV_A });
    register("inst-b", { environmentId: ENV_B });
    register("inst-dead", { environmentId: ENV_B, instanceNumber: 2 });
    snapshots = [snapshot("inst-a"), snapshot("inst-b"), snapshot("inst-dead", "stopped")];

    const grouped = groupActiveInstancesByEnvironment();
    expect(grouped.get(ENV_A)?.map((item) => item.id)).toEqual(["inst-a"]);
    expect(grouped.get(ENV_B)?.map((item) => item.id)).toEqual(["inst-b"]);
  });

  // core 已不存在时读取单实例必须释放遗留 supplement。
  test("读取缺失 core 实例时清理孤儿 supplement", () => {
    register("orphan");

    expect(getInstance("orphan")).toBeUndefined();
    expect(globalInstanceRegistry.get("orphan")).toBeUndefined();
  });

  // 用户不匹配时不得返回已登记实例。
  test("单实例查询隔离其他用户", () => {
    register("inst-private", { userId: "owner" });
    snapshots = [snapshot("inst-private")];

    expect(getInstance("inst-private", "visitor")).toBeUndefined();
  });

  // core 存在但未登记的实例不能构造业务响应。
  test("单实例查询拒绝缺少 supplement 的快照", () => {
    snapshots = [snapshot("inst-no-supplement")];

    expect(getInstance("inst-no-supplement")).toBeUndefined();
  });

  // 编排域最小实例视图应从 core 与 registry 补齐展示字段。
  test("编排实例响应从快照和 supplement 补齐字段", () => {
    register("inst-orch", { instanceNumber: 7 });
    snapshots = [snapshot("inst-orch", "running", { errorMessage: "warning" })];

    expect(toInstanceInfo({ instanceId: "inst-orch", environmentId: ENV_A, status: () => "running" })).toEqual({
      id: "inst-orch",
      port: 3100,
      status: "running",
      error: "warning",
      group_id: ENV_A,
      environment_id: ENV_A,
      session_id: null,
      instance_number: 7,
      created_at: 1_767_323_045,
    });
  });

  // interactive 实例即使长期空闲也不得自动回收。
  test("交互式实例不标记为空闲或活跃超时可回收", () => {
    const info = toInstanceActivityInfo(
      {
        id: "interactive",
        userId: "u",
        port: 1,
        pid: null,
        status: "running",
        command: "",
        error: null,
        apiKey: "",
        createdAt: new Date(0),
        instanceNumber: 1,
      },
      {
        userId: "u",
        environmentId: ENV_A,
        instanceNumber: 1,
        organizationId: ORG_A,
        spawnSource: "interactive",
        lastActivityAt: 0,
        relayCount: 0,
        lastRelayDetachedAt: 0,
      },
      10,
      10,
      20_000,
    );

    expect(info).toMatchObject({
      idle_seconds: 20,
      inactivity_seconds: 20,
      idle_kill_eligible: false,
      activity_kill_eligible: false,
    });
  });

  // 有 relay 连接时不应计算空闲并触发空闲清理。
  test("已连接 relay 的后台实例不触发空闲回收", () => {
    const info = toInstanceActivityInfo(
      {
        id: "connected",
        userId: "u",
        port: 1,
        pid: null,
        status: "running",
        command: "",
        error: null,
        apiKey: "",
        createdAt: new Date(0),
        instanceNumber: 1,
      },
      {
        userId: "u",
        environmentId: ENV_A,
        instanceNumber: 1,
        organizationId: ORG_A,
        spawnSource: "scheduled",
        lastActivityAt: 19_000,
        relayCount: 1,
        lastRelayDetachedAt: null,
      },
      10,
      10,
      20_000,
    );

    expect(info).toMatchObject({ idle_seconds: 0, idle_kill_eligible: false, activity_kill_eligible: false });
  });

  // 环境响应只暴露活跃实例，并保持实例编号和时间契约。
  test("环境实例响应排除终态并转换时间", () => {
    register("inst-visible", { instanceNumber: 4 });
    register("inst-hidden", { instanceNumber: 5 });
    snapshots = [snapshot("inst-visible"), snapshot("inst-hidden", "error")];

    expect(listInstancesResponse(ENV_A)).toEqual({
      environment_id: ENV_A,
      instances: [
        {
          id: "inst-visible",
          instance_number: 4,
          status: "running",
          session_id: null,
          port: 3100,
          created_at: 1_767_323_045,
        },
      ],
    });
  });

  // 未指定编号时必须复用现有运行实例，不触发环境查询或启动。
  test("ensureRunning 复用同环境的首个运行实例", async () => {
    register("inst-reuse");
    snapshots = [snapshot("inst-reuse")];

    await expect(ensureRunning("another-user", ENV_A)).resolves.toMatchObject({
      status: "reused",
      instance: { id: "inst-reuse" },
    });
  });

  // 指定编号时必须精准复用对应运行实例。
  test("ensureRunning 按指定实例编号复用目标实例", async () => {
    register("inst-one", { instanceNumber: 1 });
    register("inst-two", { instanceNumber: 2 });
    snapshots = [snapshot("inst-one"), snapshot("inst-two")];

    await expect(ensureRunning("user-a", ENV_A, "scheduled", 2)).resolves.toMatchObject({
      status: "reused",
      instance: { id: "inst-two" },
    });
  });

  // 环境不存在时启动请求应返回明确的 NotFoundError。
  test("ensureRunning 在环境不存在时失败", async () => {
    stubEnvironmentRepo({ getById: async () => null });

    await expect(ensureRunning("user-a", ENV_A)).rejects.toBeInstanceOf(NotFoundError);
  });

  // 禁用 autoStart 时不允许隐式启动实例。
  test("ensureRunning 在禁用 autoStart 时返回冲突错误", async () => {
    stubEnvironmentRepo({ getById: async () => ({ autoStart: false, maxSessions: 2 }) });

    await expect(ensureRunning("user-a", ENV_A)).rejects.toMatchObject({
      code: "AUTO_START_DISABLED",
      statusCode: 409,
    } satisfies Partial<AppError>);
  });

  // 指定未运行编号也必须遵循 autoStart 禁用策略。
  test("指定实例编号在禁用 autoStart 时返回编号相关错误", async () => {
    stubEnvironmentRepo({ getById: async () => ({ autoStart: false, maxSessions: 2 }) });

    await expect(ensureRunning("user-a", ENV_A, "scheduled", 3)).rejects.toThrow("实例 3 未运行且 autoStart 已禁用");
  });

  // 指定不存在或非运行编号时，进入环境不得偷偷启动其他实例。
  test("enterEnvironment 拒绝指定未运行实例编号", async () => {
    register("inst-stopped", { instanceNumber: 9 });
    snapshots = [snapshot("inst-stopped", "stopped")];

    await expect(enterEnvironment("user-a", ENV_A, 9)).rejects.toThrow("实例 9 不存在或未运行");
  });

  // 已运行编号进入环境应生成确定性的实例会话响应。
  test("enterEnvironment 为指定运行实例生成会话响应", async () => {
    register("inst-enter", { instanceNumber: 6 });
    snapshots = [snapshot("inst-enter")];

    await expect(enterEnvironment("user-a", ENV_A, 6)).resolves.toMatchObject({
      instance_id: "inst-enter",
      instance_number: 6,
      instance_status: "running",
      environment_id: ENV_A,
    });
  });

  // 跨组织停止请求必须在触碰编排或 core 前拒绝。
  test("stopInstance 拒绝跨组织停止", async () => {
    register("inst-owned", { organizationId: ORG_A });

    await expect(stopInstance("inst-owned", ORG_B)).resolves.toEqual({ ok: false, error: "Not your instance" });
    expect(stoppedIds).toEqual([]);
  });

  // 批量停止需兜底回收不在编排活跃表中的 core 残留并清空业务注册表。
  test("stopAllInstances 停止 core 残留并释放所有 supplement", async () => {
    register("inst-legacy");
    snapshots = [snapshot("inst-legacy"), snapshot("inst-stopped", "stopped")];

    await stopAllInstances();

    expect(stoppedIds).toEqual(["inst-legacy"]);
    expect(globalInstanceRegistry.size).toBe(0);
  });
});
