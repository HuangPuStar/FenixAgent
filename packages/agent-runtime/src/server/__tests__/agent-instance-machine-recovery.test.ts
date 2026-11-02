import { describe, expect, test } from "bun:test";
import type { AgentInstanceRecord } from "../repositories";
import { AgentInstanceRuntimeCoordinator } from "../services/agent-instance-runtime-coordinator";
import type { RuntimeAdapter } from "../services/agent-instance-runtime-types";

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

describe("Coordinator machine runtime recovery", () => {
  // disconnect 只接受当前 generation，并标记 unknown；迟到 death 不得覆盖该 fence 后状态。
  test("disconnect and death events respect generation fencing", async () => {
    const adapter: RuntimeAdapter = { async start() {}, async stop() {} };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    coordinator.handleRuntimeDisconnect(instance.id, generation, "mach_test");
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
    coordinator.handleRuntimeDeath(instance.id, generation);
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });

  // 机器 clean-slate 确认代表该机旧 runtime 已终止，应解除断连造成的 unknown，使实例可再次进入。
  test("machine clean slate resolves unknown entries caused by that machine disconnect", async () => {
    let starts = 0;
    const adapter: RuntimeAdapter = {
      async start() {
        starts += 1;
      },
      async stop() {},
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    coordinator.handleRuntimeDisconnect(instance.id, generation, "mach_1");
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
    await expect(coordinator.ensureRuntime(instance)).rejects.toThrow("Runtime state for");

    const resolved = coordinator.handleMachineCleanSlate("mach_1");

    expect(resolved).toEqual([instance.id]);
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
    await coordinator.ensureRuntime(instance);
    expect(starts).toBe(2);
  });

  // 归属机器是隔离维度，别的机器的确认不得放行未知条目，否则可能与旧进程重复启动。
  test("machine clean slate does not resolve unknown entries of other machines", async () => {
    const adapter: RuntimeAdapter = { async start() {}, async stop() {} };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    coordinator.handleRuntimeDisconnect(instance.id, generation, "mach_a");

    expect(coordinator.handleMachineCleanSlate("mach_b")).toEqual([]);
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });

  // 确认到达时条目仍被在飞操作独占，复位必须延后到操作释放槽位之后。
  test("machine clean slate defers when an operation is still in flight", async () => {
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
    const starting = coordinator.ensureRuntime(instance);
    coordinator.handleRuntimeDisconnect(instance.id, coordinator.snapshot(instance.id).runtimeGeneration, "mach_1");

    expect(coordinator.handleMachineCleanSlate("mach_1")).toEqual([]);
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");

    release?.();
    await expect(starting).rejects.toThrow("disconnected");
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
  });

  // 只复位 unknown，健康 runtime 与已停止条目不得被改写，避免诱发重复启动。
  test("machine clean slate leaves running and stopped entries untouched", async () => {
    const adapter: RuntimeAdapter = { async start() {}, async stop() {} };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);

    expect(coordinator.handleMachineCleanSlate("mach_1")).toEqual([]);
    expect(coordinator.snapshot(instance.id).state).toBe("running");

    await coordinator.stopRuntime(instance, "strict");

    expect(coordinator.handleMachineCleanSlate("mach_1")).toEqual([]);
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
  });

  // 复位推进世代是为了 fence 迟到通知，迟到的 disconnect/death 不得回写已复位状态。
  test("late lifecycle events are ignored after clean slate resolution", async () => {
    const adapter: RuntimeAdapter = { async start() {}, async stop() {} };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    coordinator.handleRuntimeDisconnect(instance.id, generation, "mach_1");
    expect(coordinator.handleMachineCleanSlate("mach_1")).toEqual([instance.id]);
    const settledGeneration = coordinator.snapshot(instance.id).runtimeGeneration;

    coordinator.handleRuntimeDisconnect(instance.id, generation, "mach_1");
    coordinator.handleRuntimeDeath(instance.id, generation);

    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
    expect(coordinator.snapshot(instance.id).runtimeGeneration).toBe(settledGeneration);
  });

  // 新 lifecycle intent 接管条目后旧断连归属必须立即失效，否则本机早先的 clean-slate 确认会放行
  // 之后在另一台机器上产生的 unknown，可能与旧进程并存。
  test("new lifecycle intent invalidates the machine attribution", async () => {
    const adapter: RuntimeAdapter = {
      async start() {},
      async stop() {},
      hasActiveRuntime() {
        return true;
      },
      async stopActiveRuntime() {
        throw new Error("stop failed");
      },
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    await coordinator.ensureRuntime(instance);
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    coordinator.handleRuntimeDisconnect(instance.id, generation, "mach_a");
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");

    await expect(coordinator.stopRuntime(instance, "strict")).rejects.toThrow("stop failed");

    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
    expect(coordinator.handleMachineCleanSlate("mach_a")).toEqual([]);
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });

  // 被断连 fence 的在飞操作必须释放操作槽位，否则同操作此后会假等待一个已 settle 的 promise（假成功）。
  test("fenced in-flight operation releases its slot", async () => {
    let starts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: RuntimeAdapter = {
      async start() {
        starts += 1;
        if (starts === 1) await gate;
      },
      async stop() {},
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    const starting = coordinator.ensureRuntime(instance);
    coordinator.handleRuntimeDisconnect(instance.id, coordinator.snapshot(instance.id).runtimeGeneration, "mach_1");
    coordinator.handleMachineCleanSlate("mach_1");

    release?.();
    await expect(starting).rejects.toThrow("disconnected");
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");

    await coordinator.ensureRuntime(instance);

    expect(starts).toBe(2);
  });
});
