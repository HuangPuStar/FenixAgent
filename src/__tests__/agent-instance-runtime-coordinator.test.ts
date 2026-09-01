import { describe, expect, test } from "bun:test";
import type { AgentInstanceRecord, IAgentInstanceRepo } from "../repositories";
import { AgentInstanceRuntimeCoordinator, type RuntimeAdapter } from "../services/agent-instance-runtime-coordinator";
import { AgentInstanceService } from "../services/agent-instance-service";

const instance: AgentInstanceRecord = {
  id: "inst_00000000000000000000000000000001",
  environmentId: "env_1",
  ownerUserId: "user_1",
  creationSource: "api",
  name: "primary",
  isDefault: false,
  createdByUserId: "user_1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("AgentInstanceRuntimeCoordinator", () => {
  // 并发 ensure 必须共享同一启动操作，避免同一持久 Instance 产生两个 runtime。
  test("concurrent ensure is singleflight", async () => {
    let starts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: RuntimeAdapter = {
      async start() {
        starts += 1;
        await gate;
      },
      async stop() {},
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    const first = coordinator.ensureRuntime(instance);
    const second = coordinator.ensureRuntime(instance);
    expect(starts).toBe(1);
    release?.();
    await Promise.all([first, second]);
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });

  // waiter 自身取消不得取消共享启动，否则会影响同 uid 的其他调用者。
  test("waiter cancellation does not cancel shared ensure", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: RuntimeAdapter = {
      async start() {
        await gate;
      },
      async stop() {},
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    const abort = new AbortController();
    const cancelled = coordinator.ensureRuntime(instance, abort.signal);
    const waiting = coordinator.ensureRuntime(instance);
    abort.abort(new Error("cancelled"));
    await expect(cancelled).rejects.toThrow("cancelled");
    release?.();
    await waiting;
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });

  // generation 不匹配的死亡事件必须被 fencing，不能覆盖新 runtime 状态。
  test("stale runtime death is ignored", async () => {
    const adapter: RuntimeAdapter = { async start() {}, async stop() {} };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    await coordinator.restartRuntime(instance);
    coordinator.handleRuntimeDeath(instance.id, generation);
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });

  // stop 执行期间到达的 ensure 必须在 stop 后真正重启，不能继承 stop 的成功结果。
  test("ensure queued behind stop starts runtime", async () => {
    let releaseStop: (() => void) | undefined;
    let starts = 0;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const adapter: RuntimeAdapter = {
      async start() {
        starts += 1;
      },
      async stop() {
        await stopGate;
      },
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    const stopping = coordinator.stopRuntime(instance, "strict");
    const ensuring = coordinator.ensureRuntime(instance);
    releaseStop?.();
    await Promise.all([stopping, ensuring]);
    expect(starts).toBe(2);
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });

  // restart 的停止阶段失败意味着真实 runtime 未知，不能错误标记为 stopped 后重复启动。
  test("restart stop failure enters unknown", async () => {
    let failStop = false;
    const adapter: RuntimeAdapter = {
      async start() {},
      async stop() {
        if (failStop) throw new Error("restart stop failed");
      },
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    failStop = true;
    await expect(coordinator.restartRuntime(instance)).rejects.toThrow("restart stop failed");
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });

  // strict stop 失败必须暴露错误并进入 unknown，禁止后续 ensure 猜测 runtime 状态。
  test("strict stop failure enters unknown", async () => {
    const adapter: RuntimeAdapter = {
      async start() {},
      async stop() {
        throw new Error("stop failed");
      },
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    await expect(coordinator.stopRuntime(instance, "strict")).rejects.toThrow("stop failed");
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
    await expect(coordinator.ensureRuntime(instance)).rejects.toThrow("unknown");
  });

  // shutdown 必须先关闭全局 gate，再等待已有 starting，并按启动世代补偿停止迟到 runtime。
  test("shutdown gates new operations and compensates late start generation", async () => {
    let releaseStart: (() => void) | undefined;
    let startGeneration = 0;
    let startAborted = false;
    const stopGenerations: number[] = [];
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const adapter: RuntimeAdapter = {
      async start(_instance, generation, signal) {
        startGeneration = generation;
        signal.addEventListener("abort", () => {
          startAborted = true;
        });
        await startGate;
      },
      async stop(_instanceUid, generation) {
        stopGenerations.push(generation);
      },
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    const starting = coordinator.ensureRuntime(instance);
    const shutdown = coordinator.shutdown();

    await expect(coordinator.ensureRuntime(instance)).rejects.toThrow("shutting down");
    await expect(coordinator.restartRuntime(instance)).rejects.toThrow("shutting down");
    await expect(coordinator.stopRuntime(instance, "strict")).rejects.toThrow("shutting down");
    await expect(coordinator.deleteRuntime(instance)).rejects.toThrow("shutting down");
    expect(startAborted).toBeTrue();

    releaseStart?.();
    await Promise.allSettled([starting, shutdown]);
    expect(stopGenerations).toEqual([startGeneration]);
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
  });

  // shutdown stop 必须使用不可变 generation 快照，且多次调用只能执行一次 drain。
  test("shutdown is idempotent and stops the snapshotted generation", async () => {
    const stopGenerations: number[] = [];
    const adapter: RuntimeAdapter = {
      async start() {},
      async stop(_instanceUid, generation) {
        stopGenerations.push(generation);
      },
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    const first = coordinator.shutdown();
    const second = coordinator.shutdown();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(stopGenerations).toEqual([generation]);
  });

  // stop 永不返回时 shutdown 必须 bounded 返回，并把无法确认的真实状态保留为 unknown。
  test("shutdown timeout leaves hanging stop unknown", async () => {
    const adapter: RuntimeAdapter = {
      async start() {},
      async stop() {
        await new Promise<void>(() => {});
      },
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter, { shutdownDrainTimeoutMs: 1 });
    await coordinator.ensureRuntime(instance);
    await coordinator.shutdown();
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });

  // starting 永不返回时 shutdown 必须 bounded 返回，不能把未知外部副作用伪装为 stopped。
  test("shutdown timeout leaves hanging start unknown", async () => {
    const adapter: RuntimeAdapter = {
      async start() {
        await new Promise<void>(() => {});
      },
      async stop() {},
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter, { shutdownDrainTimeoutMs: 1 });
    void coordinator.ensureRuntime(instance);
    await coordinator.shutdown();
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });

  // Agent 配置确认后必须重启活跃 runtime，默认持久 Instance 仍保留且不会走 deleteById。
  test("restart running instances keeps default persistent instance", async () => {
    let starts = 0;
    let stops = 0;
    let deletes = 0;
    const adapter: RuntimeAdapter = {
      async start() {
        starts += 1;
      },
      async stop() {
        stops += 1;
      },
    };
    const repository = {
      listByEnvironment: async (environmentId: string) => (environmentId === instance.environmentId ? [instance] : []),
      deleteById: async () => {
        deletes += 1;
        return true;
      },
    } as unknown as IAgentInstanceRepo;
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    const service = new AgentInstanceService(repository, coordinator);
    await service.ensureInstanceRuntime(instance);

    const restarted = await service.restartRunningInstancesForEnvironments([instance.environmentId]);

    expect(restarted).toEqual([instance.id]);
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    expect(deletes).toBe(0);
    expect(service.getRuntimeSnapshot(instance.id).state).toBe("running");
  });

  // disconnect 只接受当前 generation，并标记 unknown；迟到 death 不得覆盖该 fence 后状态。
  test("disconnect and death events respect generation fencing", async () => {
    const adapter: RuntimeAdapter = { async start() {}, async stop() {} };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    coordinator.handleRuntimeDisconnect(instance.id, generation);
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
    coordinator.handleRuntimeDeath(instance.id, generation);
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });
});
