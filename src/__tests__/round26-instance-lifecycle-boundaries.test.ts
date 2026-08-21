import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setConfig } from "../config";
import {
  listInstanceActivitySnapshots,
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  resetAcpIdleMonitorDeps,
  runAcpIdleMonitorSweep,
  setAcpIdleMonitorDeps,
  shouldCountInstanceActivity,
  touchInstanceActivity,
} from "../services/acp-idle-monitor";
import type { getCoreRuntime } from "../services/core-bootstrap";
import type { SpawnedInstance } from "../services/instance";
import { globalInstanceRegistry, InstanceRegistry } from "../services/instance-registry";
import type { InstanceSupplement } from "../types/store";

function supplement(overrides: Partial<InstanceSupplement> = {}): InstanceSupplement {
  return {
    userId: "user-a",
    environmentId: "env-a",
    instanceNumber: 1,
    organizationId: "org-a",
    spawnSource: "scheduled",
    lastActivityAt: 1_000,
    relayCount: 0,
    lastRelayDetachedAt: 1_000,
    ...overrides,
  };
}

function instance(id: string, environmentId = "env-a"): SpawnedInstance {
  return {
    id,
    userId: "user-a",
    port: 0,
    pid: null,
    status: "running",
    command: "",
    error: null,
    apiKey: "",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    environmentId,
    sessionId: undefined,
    instanceNumber: 1,
  };
}

function runtime(instances: Array<Record<string, unknown>>): ReturnType<typeof getCoreRuntime> {
  return { listInstances: () => instances } as unknown as ReturnType<typeof getCoreRuntime>;
}

describe("round26 实例注册表隔离与资源释放", () => {
  // 不同环境的实例必须保留各自独立的索引。
  test("按环境读取不会混入其他环境实例", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement({ environmentId: "env-a" }));
    registry.register("inst-b", supplement({ environmentId: "env-b" }));
    expect(registry.getByEnvironment("env-a").map(([id]) => id)).toEqual(["inst-a"]);
  });

  // 查询未知环境不得意外暴露已有实例。
  test("未知环境返回空实例列表", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement());
    expect(registry.getByEnvironment("env-missing")).toEqual([]);
  });

  // 注销未知实例必须是安全幂等操作。
  test("注销未知实例不会改变注册表", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement());
    registry.unregister("inst-missing");
    expect(registry.size).toBe(1);
  });

  // 环境计数器不能影响其他租户环境的实例编号。
  test("实例编号按环境独立递增", () => {
    const registry = new InstanceRegistry();
    expect(registry.nextInstanceNumber("env-a")).toBe(1);
    expect(registry.nextInstanceNumber("env-b")).toBe(1);
    expect(registry.nextInstanceNumber("env-a")).toBe(2);
  });

  // 现有实例编号必须防止计数器回退造成冲突。
  test("现有较大编号会抬高下一编号", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement({ instanceNumber: 8 }));
    expect(registry.nextInstanceNumber("env-a")).toBe(9);
  });

  // 已有实例时不得提前释放环境计数器。
  test("仍有同环境实例时不释放计数器", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement());
    registry.register("inst-b", supplement({ instanceNumber: 2 }));
    expect(registry.nextInstanceNumber("env-a")).toBe(3);
    registry.unregisterAndDeleteCounter("inst-a");
    expect(registry.nextInstanceNumber("env-a")).toBe(4);
  });

  // 最后一个实例卸载后应释放配额计数器。
  test("最后一个实例卸载后编号从一重新开始", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement());
    expect(registry.nextInstanceNumber("env-a")).toBe(2);
    registry.unregisterAndDeleteCounter("inst-a");
    expect(registry.nextInstanceNumber("env-a")).toBe(1);
  });

  // 强制卸载未知实例不能删除其他环境的计数器。
  test("卸载未知实例不会释放已有环境计数器", () => {
    const registry = new InstanceRegistry();
    expect(registry.nextInstanceNumber("env-a")).toBe(1);
    registry.unregisterAndDeleteCounter("inst-missing");
    expect(registry.nextInstanceNumber("env-a")).toBe(2);
  });

  // 业务消息应刷新活动时间。
  test("业务活动更新最后活跃时间", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement({ lastActivityAt: 1 }));
    registry.touchActivity("inst-a", 99);
    expect(registry.get("inst-a")?.lastActivityAt).toBe(99);
  });

  // 前台连接中的业务活动应取消旧的断开观察点。
  test("连接存在时业务活动清除断开时间", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement({ relayCount: 1, lastRelayDetachedAt: 1 }));
    registry.touchActivity("inst-a", 99);
    expect(registry.get("inst-a")?.lastRelayDetachedAt).toBeNull();
  });

  // 未注册实例的活动上报不得创建幽灵条目。
  test("未知实例活动上报不会创建记录", () => {
    const registry = new InstanceRegistry();
    registry.touchActivity("inst-missing", 99);
    expect(registry.size).toBe(0);
  });

  // relay 附着应累计连接数并恢复前台状态。
  test("附着 relay 增加连接数并更新活动时间", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement({ lastRelayDetachedAt: 1 }));
    registry.attachRelay("inst-a", 99);
    expect(registry.get("inst-a")).toMatchObject({ relayCount: 1, lastActivityAt: 99, lastRelayDetachedAt: null });
  });

  // 多个 relay 时断开一个不能开始空闲倒计时。
  test("部分 relay 断开不会开始空闲观察", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement({ relayCount: 2, lastRelayDetachedAt: null }));
    registry.detachRelay("inst-a", 99);
    expect(registry.get("inst-a")).toMatchObject({ relayCount: 1, lastRelayDetachedAt: null });
  });

  // 最后一个 relay 断开才应开始空闲观察。
  test("最后一个 relay 断开记录观察起点", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement({ relayCount: 1, lastRelayDetachedAt: null }));
    registry.detachRelay("inst-a", 99);
    expect(registry.get("inst-a")).toMatchObject({ relayCount: 0, lastRelayDetachedAt: 99 });
  });

  // 重复断开不得把 relay 数量减为负值。
  test("重复断开 relay 保持零计数", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement({ relayCount: 0 }));
    registry.detachRelay("inst-a", 99);
    registry.detachRelay("inst-a", 100);
    expect(registry.get("inst-a")).toMatchObject({ relayCount: 0, lastRelayDetachedAt: 100 });
  });

  // 清空必须同时释放条目、索引和编号状态。
  test("清空注册表释放所有环境状态", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement());
    registry.nextInstanceNumber("env-a");
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.getByEnvironment("env-a")).toEqual([]);
    expect(registry.nextInstanceNumber("env-a")).toBe(1);
  });

  // 对账必须移除 core 不存在的孤儿实例。
  test("对账移除缺失于 core 的孤儿实例", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-live", supplement());
    registry.register("inst-orphan", supplement({ environmentId: "env-b" }));
    registry.reconcile(() => [{ instanceId: "inst-live" }]);
    expect(registry.has("inst-live")).toBe(true);
    expect(registry.has("inst-orphan")).toBe(false);
  });

  // 对账空 core 列表必须清理所有补充数据。
  test("空 core 快照清理全部孤儿实例", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement());
    registry.register("inst-b", supplement({ environmentId: "env-b" }));
    registry.reconcile(() => []);
    expect(registry.size).toBe(0);
  });

  // entries 应只返回当前存活条目。
  test("entries 不返回已注销实例", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-a", supplement());
    registry.unregister("inst-a");
    expect([...registry.entries()]).toEqual([]);
  });

  // has 必须准确表达实例生命周期状态。
  test("has 随注册和注销准确转换", () => {
    const registry = new InstanceRegistry();
    expect(registry.has("inst-a")).toBe(false);
    registry.register("inst-a", supplement());
    expect(registry.has("inst-a")).toBe(true);
    registry.unregister("inst-a");
    expect(registry.has("inst-a")).toBe(false);
  });
});

describe("round26 ACP 活动、租户过滤与回收边界", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    resetAcpIdleMonitorDeps();
    setConfig({ acpIdleTimeoutSeconds: 10, acpActivityTimeoutSeconds: 20, acpIdleSweepIntervalSeconds: 60 });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    resetAcpIdleMonitorDeps();
  });

  // keep_alive 是传输噪音，不能延长业务实例寿命。
  test("keep_alive 不计入业务活动", () => {
    expect(shouldCountInstanceActivity({ type: "keep_alive" })).toBe(false);
  });

  // heartbeat 是传输噪音，不能延长业务实例寿命。
  test("heartbeat 不计入业务活动", () => {
    expect(shouldCountInstanceActivity({ type: "heartbeat" })).toBe(false);
  });

  // ping 是传输噪音，不能延长业务实例寿命。
  test("ping 不计入业务活动", () => {
    expect(shouldCountInstanceActivity({ type: "ping" })).toBe(false);
  });

  // pong 是传输噪音，不能延长业务实例寿命。
  test("pong 不计入业务活动", () => {
    expect(shouldCountInstanceActivity({ type: "pong" })).toBe(false);
  });

  // 任意业务类型消息都应刷新活动状态。
  test("普通业务消息计入活动", () => {
    expect(shouldCountInstanceActivity({ type: "session_data" })).toBe(true);
  });

  // JSON-RPC 请求即使携带保活 type 也属于业务协议调用。
  test("JSON-RPC 请求优先计入活动", () => {
    expect(shouldCountInstanceActivity({ jsonrpc: "2.0", type: "ping" })).toBe(true);
  });

  // 缺少 type 的有效输入应采用保守计入策略。
  test("缺少类型的消息计入活动", () => {
    expect(shouldCountInstanceActivity({})).toBe(true);
  });

  // 忽略保活消息时不得改写活动时间。
  test("保活消息不会触碰实例活动时间", () => {
    globalInstanceRegistry.register("inst-a", supplement({ lastActivityAt: 1 }));
    touchInstanceActivity("inst-a", { type: "heartbeat" }, 99);
    expect(globalInstanceRegistry.get("inst-a")?.lastActivityAt).toBe(1);
  });

  // 业务消息必须通过公共入口刷新活动时间。
  test("业务消息通过公共入口刷新活动时间", () => {
    globalInstanceRegistry.register("inst-a", supplement({ lastActivityAt: 1 }));
    touchInstanceActivity("inst-a", { type: "session_data" }, 99);
    expect(globalInstanceRegistry.get("inst-a")?.lastActivityAt).toBe(99);
  });

  // 附着入口必须恢复实例前台连接状态。
  test("公共附着入口增加 relay 数量", () => {
    globalInstanceRegistry.register("inst-a", supplement());
    markInstanceRelayAttached("inst-a", 99);
    expect(globalInstanceRegistry.get("inst-a")?.relayCount).toBe(1);
  });

  // 分离入口必须记录空闲回收的起始时刻。
  test("公共分离入口记录断开时间", () => {
    globalInstanceRegistry.register("inst-a", supplement({ relayCount: 1, lastRelayDetachedAt: null }));
    markInstanceRelayDetached("inst-a", 99);
    expect(globalInstanceRegistry.get("inst-a")?.lastRelayDetachedAt).toBe(99);
  });

  // 组织过滤不能暴露其他租户的活动实例。
  test("活动快照按组织隔离", () => {
    globalInstanceRegistry.register("inst-a", supplement({ organizationId: "org-a" }));
    globalInstanceRegistry.register("inst-b", supplement({ organizationId: "org-b", environmentId: "env-b" }));
    setAcpIdleMonitorDeps({
      getCoreRuntime: () =>
        runtime([
          { instanceId: "inst-a", status: "running" },
          { instanceId: "inst-b", status: "running" },
        ]),
      getInstance: (id) => (id === "inst-a" ? instance(id) : instance(id, "env-b")),
    });
    expect(listInstanceActivitySnapshots(2_000, "org-a").map((item) => item.id)).toEqual(["inst-a"]);
  });

  // 无归属 supplement 的实例不得出现在任一组织视图。
  test("组织视图隐藏缺少归属信息的 runtime 实例", () => {
    setAcpIdleMonitorDeps({ getCoreRuntime: () => runtime([{ instanceId: "inst-a", status: "running" }]) });
    expect(listInstanceActivitySnapshots(2_000, "org-a")).toEqual([]);
  });

  // 全局管理视图可观察没有 supplement 的活跃 runtime，避免资源泄漏不可见。
  test("全局视图保留缺少 supplement 的运行实例", () => {
    setAcpIdleMonitorDeps({
      getCoreRuntime: () =>
        runtime([{ instanceId: "inst-a", status: "running", createdAt: new Date(0), pluginMetadata: { port: 9527 } }]),
    });
    expect(listInstanceActivitySnapshots(2_000)).toMatchObject([{ id: "inst-a", port: 9527, environment_id: null }]);
  });

  // 默认视图不应将错误实例伪装成活跃实例。
  test("默认活动视图排除错误实例", () => {
    setAcpIdleMonitorDeps({ getCoreRuntime: () => runtime([{ instanceId: "inst-a", status: "error" }]) });
    expect(listInstanceActivitySnapshots(2_000)).toEqual([]);
  });

  // 管理诊断视图可显式包含错误实例。
  test("诊断活动视图包含错误实例", () => {
    setAcpIdleMonitorDeps({
      getCoreRuntime: () =>
        runtime([{ instanceId: "inst-a", status: "error", createdAt: new Date(0), errorMessage: "failed" }]),
    });
    expect(listInstanceActivitySnapshots(2_000, undefined, true)[0]).toMatchObject({
      id: "inst-a",
      status: "error",
      error: "failed",
    });
  });

  // scheduled 实例业务长期无响应时，即使 relay 仍在也必须释放资源。
  test("无活动的 scheduled 实例会被回收", async () => {
    const stopped: string[] = [];
    globalInstanceRegistry.register("inst-a", supplement({ relayCount: 1, lastActivityAt: 0 }));
    setAcpIdleMonitorDeps({
      getCoreRuntime: () => runtime([{ instanceId: "inst-a", status: "running" }]),
      getInstance: () => instance("inst-a"),
      stopInstance: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    });
    await runAcpIdleMonitorSweep(20_000);
    expect(stopped).toEqual(["inst-a"]);
  });

  // interactive 会话只能由用户显式结束，不得被后台巡检回收。
  test("无活动的 interactive 实例不会被回收", async () => {
    const stopped: string[] = [];
    globalInstanceRegistry.register("inst-a", supplement({ spawnSource: "interactive", lastActivityAt: 0 }));
    setAcpIdleMonitorDeps({
      getCoreRuntime: () => runtime([{ instanceId: "inst-a", status: "running" }]),
      getInstance: () => instance("inst-a"),
      stopInstance: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    });
    await runAcpIdleMonitorSweep(20_000);
    expect(stopped).toEqual([]);
  });

  // detached 的 scheduled 实例超过 idle 窗口必须释放资源。
  test("超时空闲的 scheduled 实例会被回收", async () => {
    const stopped: string[] = [];
    globalInstanceRegistry.register("inst-a", supplement({ lastActivityAt: 5_000, lastRelayDetachedAt: 5_000 }));
    setAcpIdleMonitorDeps({
      getCoreRuntime: () => runtime([{ instanceId: "inst-a", status: "running" }]),
      getInstance: () => instance("inst-a"),
      stopInstance: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    });
    await runAcpIdleMonitorSweep(15_000);
    expect(stopped).toEqual(["inst-a"]);
  });

  // 仍有前台 relay 的实例不能仅因 idle 时间而被回收。
  test("有 relay 的 scheduled 实例跳过空闲回收", async () => {
    const stopped: string[] = [];
    globalInstanceRegistry.register(
      "inst-a",
      supplement({ relayCount: 1, lastActivityAt: 5_000, lastRelayDetachedAt: 5_000 }),
    );
    setAcpIdleMonitorDeps({
      getCoreRuntime: () => runtime([{ instanceId: "inst-a", status: "running" }]),
      getInstance: () => instance("inst-a"),
      stopInstance: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    });
    await runAcpIdleMonitorSweep(15_000);
    expect(stopped).toEqual([]);
  });

  // 未达到任一超时阈值的实例必须继续运行。
  test("未超时实例不会被提前回收", async () => {
    const stopped: string[] = [];
    globalInstanceRegistry.register("inst-a", supplement({ lastActivityAt: 10_000, lastRelayDetachedAt: 10_000 }));
    setAcpIdleMonitorDeps({
      getCoreRuntime: () => runtime([{ instanceId: "inst-a", status: "running" }]),
      getInstance: () => instance("inst-a"),
      stopInstance: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    });
    await runAcpIdleMonitorSweep(19_999);
    expect(stopped).toEqual([]);
  });

  // 停止失败不得中断同一轮其他实例的资源回收。
  test("单个回收异常不会阻断后续实例回收", async () => {
    const stopped: string[] = [];
    globalInstanceRegistry.register("inst-a", supplement({ lastActivityAt: 0 }));
    globalInstanceRegistry.register("inst-b", supplement({ environmentId: "env-b", lastActivityAt: 0 }));
    setAcpIdleMonitorDeps({
      getCoreRuntime: () =>
        runtime([
          { instanceId: "inst-a", status: "running" },
          { instanceId: "inst-b", status: "running" },
        ]),
      getInstance: (id) => instance(id, id === "inst-b" ? "env-b" : "env-a"),
      stopInstance: async (id) => {
        stopped.push(id);
        if (id === "inst-a") throw new Error("stop failed");
        return { ok: true };
      },
    });
    await runAcpIdleMonitorSweep(20_000);
    expect(stopped).toEqual(["inst-a", "inst-b"]);
  });
});
