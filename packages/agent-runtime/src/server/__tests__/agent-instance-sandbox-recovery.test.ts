import { describe, expect, test } from "bun:test";
import {
  SandboxExecutionHandler,
  type SandboxInstanceLockScope,
  SandboxManager,
  SandboxProviderRegistry,
} from "@fenix/resource-sandbox/server";
import type { AgentInstanceRecord, IAgentInstanceRepo } from "../repositories";
import { AgentInstanceRuntimeCoordinator } from "../services/agent-instance-runtime-coordinator";
import { AgentInstanceService } from "../services/agent-instance-service";

const instance: AgentInstanceRecord = {
  id: "inst_00000000000000000000000000000011",
  environmentId: "env_recovery",
  ownerUserId: "user_recovery",
  creationSource: "user",
  name: "default",
  isDefault: true,
  createdByUserId: "user_recovery",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const machineId = "mach_sandbox_recovery";
const unusedRepository = {} as IAgentInstanceRepo;

describe("Instance sandbox recovery preflight", () => {
  // 真实服务、仲裁器和沙盒编排共同覆盖断连再进入，验证旧配额先释放、持久身份不变。
  test("recovers a dead sandbox through the real service and provider boundary", async () => {
    const starts: string[] = [];
    const released: string[] = [];
    let online = false;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start(record) {
        starts.push(record.id);
      },
      async stop() {},
      onStopped(uid) {
        released.push(uid);
      },
    });
    let row: NonNullable<Awaited<ReturnType<SandboxInstanceLockScope["findById"]>>> = {
      id: "sbi_recovery",
      machineId,
      userId: instance.ownerUserId,
      sandboxPoolId: "pool_recovery",
      providerKey: "test",
      status: "ready",
      externalSandboxId: "old",
      resolvedConfig: {
        image: "sandbox:test",
        resources: { cpu: 1, memoryMb: 512, diskGb: 5, gpuCount: 0, volumes: [], environment: {} },
        providerExtra: {},
      },
      resourceOverrides: null,
      providerPayload: null,
      lastHeartbeatAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const update: SandboxInstanceLockScope["update"] = async (_id, status, patch) =>
      (row = { ...row, status, ...patch });
    const providers = new SandboxProviderRegistry();
    providers.register("test", {
      async get() {
        return { sandboxId: "old", status: "ready" };
      },
      async destroy() {},
      async resume() {
        throw new Error("must rebuild");
      },
      async create() {
        expect(released).toEqual([instance.id]);
        online = true;
        return { sandboxId: "new", status: "ready" };
      },
    });
    const manager = new SandboxManager({
      instances: {
        findByMachineId: async () => row,
        findActive: async () => row,
        findById: async () => row,
        findByIdForUser: async () => row,
        create: async () => row,
        update,
        withLock: async (_id, action) => action({ findById: async () => row, update, delete: async () => row }),
      },
      providers,
      isMachineOnline: async () => online,
      releaseRuntime: () => {
        coordinator.handleRuntimeTerminated({ machineId });
      },
    });
    const handler = new SandboxExecutionHandler(manager, async () => online);
    const service = new AgentInstanceService(unusedRepository, coordinator, (input) =>
      handler.recoverDisconnectedMachine({ ...input, runtimeConnectTimeoutMs: 20 }),
    );
    await service.ensureInstanceRuntime(instance);
    const oldGeneration = coordinator.snapshot(instance.id).runtimeGeneration;
    coordinator.handleRuntimeDisconnect(instance.id, oldGeneration, machineId);
    await service.ensureInstanceRuntime(instance);
    expect(starts).toEqual([instance.id, instance.id]);
    expect(row.externalSandboxId).toBe("new");
    coordinator.handleRuntimeDisconnect(instance.id, oldGeneration, machineId);
    coordinator.handleRuntimeDeath(instance.id, oldGeneration);
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });

  // 停止失败造成的 unknown 没有断连归属，不能借沙盒恢复绕过门禁。
  test("does not recover unknown caused by stop failure", async () => {
    let recoveries = 0;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {},
      async stop() {
        throw new Error("stop failed");
      },
    });
    const service = new AgentInstanceService(unusedRepository, coordinator, async () => {
      recoveries += 1;
    });
    await service.ensureInstanceRuntime(instance);
    await expect(coordinator.stopRuntime(instance, "strict")).rejects.toThrow("stop failed");
    await expect(service.ensureInstanceRuntime(instance)).rejects.toThrow("unknown");
    expect(recoveries).toBe(0);
  });

  // 沙盒断连后的再次进入必须先恢复机器，再以同一持久身份启动 Agent。
  test("recovers a disconnected runtime before ensuring the same instance", async () => {
    const starts: string[] = [];
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start(record) {
        starts.push(record.id);
      },
      async stop() {},
    });
    const recovered: string[] = [];
    const service = new AgentInstanceService(unusedRepository, coordinator, async (input) => {
      recovered.push(input.machineId);
      expect(input.ownerUserId).toBe(instance.ownerUserId);
      expect(input.isCurrent()).toBe(true);
      coordinator.handleRuntimeTerminated({ machineId: input.machineId });
    });
    await service.ensureInstanceRuntime(instance);
    coordinator.handleRuntimeDisconnect(instance.id, coordinator.snapshot(instance.id).runtimeGeneration, machineId);

    await service.ensureInstanceRuntime(instance);

    expect(recovered).toEqual([machineId]);
    expect(starts).toEqual([instance.id, instance.id]);
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });

  // 正常运行的实例不调用沙盒恢复，也不重复启动运行实体。
  test("keeps the normal ensure path free of sandbox recovery", async () => {
    let recoveries = 0;
    let starts = 0;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        starts += 1;
      },
      async stop() {},
    });
    const service = new AgentInstanceService(unusedRepository, coordinator, async () => {
      recoveries += 1;
    });
    await service.ensureInstanceRuntime(instance);
    await service.ensureInstanceRuntime(instance);
    expect(starts).toBe(1);
    expect(recoveries).toBe(0);
  });

  // 用户在恢复期间停止实例时，旧恢复意图失效，恢复结束不得重新启动 Agent。
  test("respects a manual stop issued during recovery", async () => {
    let starts = 0;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        starts += 1;
      },
      async stop() {},
    });
    const service = new AgentInstanceService(unusedRepository, coordinator, async (input) => {
      await coordinator.stopRuntime(instance, "strict");
      expect(input.isCurrent()).toBe(false);
    });
    await service.ensureInstanceRuntime(instance);
    coordinator.handleRuntimeDisconnect(instance.id, coordinator.snapshot(instance.id).runtimeGeneration, machineId);
    await expect(service.ensureInstanceRuntime(instance)).rejects.toThrow("stopped");
    expect(starts).toBe(1);
  });

  // 恢复回调必须提供确定终止事实；返回成功本身不能绕过 unknown 安全门禁。
  test("does not clear unknown just because the recovery callback returns", async () => {
    const coordinator = new AgentInstanceRuntimeCoordinator({ async start() {}, async stop() {} });
    const service = new AgentInstanceService(unusedRepository, coordinator, async () => {});
    await service.ensureInstanceRuntime(instance);
    coordinator.handleRuntimeDisconnect(instance.id, coordinator.snapshot(instance.id).runtimeGeneration, machineId);
    await expect(service.ensureInstanceRuntime(instance)).rejects.toThrow("unknown");
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });

  // Provider 恢复失败应保留原始错误与 unknown，不伪装成已停止或运行成功。
  test("preserves the recovery error and disconnected state", async () => {
    const failure = new Error("provider unavailable");
    const coordinator = new AgentInstanceRuntimeCoordinator({ async start() {}, async stop() {} });
    const service = new AgentInstanceService(unusedRepository, coordinator, async () => {
      throw failure;
    });
    await service.ensureInstanceRuntime(instance);
    coordinator.handleRuntimeDisconnect(instance.id, coordinator.snapshot(instance.id).runtimeGeneration, machineId);
    await expect(service.ensureInstanceRuntime(instance)).rejects.toBe(failure);
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });
});

// 停止、删除、重启或关闭会接管意图，旧恢复上下文不能继续授权 Provider 副作用。
test("invalidates recovery context for newer lifecycle intents", async () => {
  for (const action of ["stop", "delete", "restart", "shutdown"] as const) {
    const coordinator = new AgentInstanceRuntimeCoordinator({ async start() {}, async stop() {} });
    await coordinator.ensureRuntime(instance);
    coordinator.handleRuntimeDisconnect(instance.id, coordinator.snapshot(instance.id).runtimeGeneration, machineId);
    const context = await coordinator.getDisconnectedRecovery(instance.id);
    expect(context?.isCurrent()).toBe(true);
    if (action === "stop") await coordinator.stopRuntime(instance, "strict");
    if (action === "delete") await coordinator.deleteRuntime(instance);
    if (action === "restart") await coordinator.restartRuntime(instance);
    if (action === "shutdown") await coordinator.shutdown();
    expect(context?.isCurrent()).toBe(false);
    expect(await coordinator.getDisconnectedRecovery(instance.id)).toBeNull();
  }
});

// 启动断连后的补偿仍在飞时，进入应等待收尾；取消该等待不能解除 unknown。
test("allows cancelling recovery preflight while disconnect cleanup is in flight", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const coordinator = new AgentInstanceRuntimeCoordinator({
    async start() {
      entered.resolve();
      await finish.promise;
    },
    async stop() {},
  });
  const starting = coordinator.ensureRuntime(instance).catch((error: unknown) => error);
  await entered.promise;
  coordinator.handleRuntimeDisconnect(instance.id, coordinator.snapshot(instance.id).runtimeGeneration, machineId);
  const controller = new AbortController();
  const context = coordinator.getDisconnectedRecovery(instance.id, controller.signal).catch((error: unknown) => error);
  controller.abort(new Error("cancelled"));
  expect(await context).toEqual(new Error("cancelled"));
  expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  finish.resolve();
  await starting;
  expect((await coordinator.getDisconnectedRecovery(instance.id))?.machineId).toBe(machineId);
});
