import { afterEach, describe, expect, test } from "bun:test";
import type { SandboxInstance, SandboxPool } from "../db/schema";
import { SandboxManager } from "../services/sandbox/sandbox-manager";
import { resetAllStubs, stubCoreBootstrap, stubRegistry } from "../test-utils/helpers";

const resources = {
  cpu: 0.5,
  memoryMb: 512,
  diskGb: 5,
  gpuCount: 0,
  environment: { LANG: "C.UTF-8" },
  volumes: [],
};

const pool = {
  id: "pool_default",
  providerKey: "test-provider",
  image: "sandbox:test",
  defaultResources: resources,
  extra: {},
} as unknown as SandboxPool;

function makeInstance(overrides: Partial<SandboxInstance> = {}): SandboxInstance {
  return {
    id: "sbi_test",
    machineId: "mach_sandbox_sbi_test",
    providerKey: "test-provider",
    sandboxPoolId: "pool_default",
    userId: "user_test",
    externalSandboxId: null,
    status: "creating",
    resolvedConfig: {},
    resourceOverrides: null,
    providerPayload: null,
    lastHeartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("SandboxManager machine identity", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 新建 Instance 必须先绑定稳定的 machine_id，并把它注入 Provider 配置环境变量。
  test("creates a machine identity and passes RCS_MACHINE_ID to the provider", async () => {
    let machineInput: Record<string, unknown> | undefined;
    let providerInput: Record<string, unknown> | undefined;
    const instance = makeInstance({ resolvedConfig: undefined as never });
    stubRegistry({
      createSandboxMachine: async (input: Record<string, unknown>) => {
        machineInput = input;
      },
    });

    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => null,
        create: async (input) => {
          Object.assign(instance, input);
          return instance;
        },
        findByIdForUser: async () => instance,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      },
      providers: {
        get: () => ({
          create: async (input: Record<string, unknown>) => {
            providerInput = input as unknown as Record<string, unknown>;
            return { sandboxId: "provider-sandbox", status: "creating" };
          },
          get: async () => null,
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" }),
          destroy: async () => {},
        }),
      } as never,
    });

    await manager.createOrReuse({
      sandboxId: "sbi_test",
      poolId: "pool_default",
      providerKey: "test-provider",
      userId: "user_test",
      template: { type: "image", value: "ignored" },
    });

    expect(machineInput).toMatchObject({ id: "mach_sandbox_sbi_test", userId: "user_test" });
    expect(instance.machineId).toBe("mach_sandbox_sbi_test");
    expect((providerInput?.resources as { environment: Record<string, string> }).environment.RCS_MACHINE_ID).toBe(
      "mach_sandbox_sbi_test",
    );
  });

  // 创建 Sandbox Machine 时应使用资源池声明的 Agent 类型，而不是固定写入 opencode。
  test("uses the agent type configured by the sandbox pool", async () => {
    let machineInput: Record<string, unknown> | undefined;
    const periPool = { ...pool, extra: { agent_type: "peri" } } as SandboxPool;
    const instance = makeInstance({ resolvedConfig: undefined as never });
    stubRegistry({
      createSandboxMachine: async (input: Record<string, unknown>) => {
        machineInput = input;
      },
    });

    const manager = new SandboxManager({
      pools: { findById: async () => periPool },
      instances: {
        findActive: async () => null,
        create: async (input) => {
          Object.assign(instance, input);
          return instance;
        },
        findByIdForUser: async () => instance,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      },
      providers: {
        get: () => ({
          create: async () => ({ sandboxId: "provider-sandbox", status: "creating" as const }),
          get: async () => null,
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {},
        }),
      } as never,
    });

    await manager.createOrReuse({
      sandboxId: "sbi_test",
      poolId: "pool_default",
      providerKey: "test-provider",
      userId: "user_test",
      template: { type: "image", value: "ignored" },
    });

    expect(machineInput?.agentName).toBe("peri");
  });

  // 创建 Instance 时，Provider 必须收到稳定用户目录下的宿主机逻辑路径。
  test("passes the stable user workspace path when creating a sandbox", async () => {
    let providerInput: Record<string, unknown> | undefined;
    const instance = makeInstance({ resolvedConfig: undefined as never });
    const workspacePool = {
      ...pool,
      defaultResources: { ...resources, volumes: [{ name: "workspace", source: "ws", target: "/workspace" }] },
    } as SandboxPool;
    const manager = new SandboxManager({
      pools: { findById: async () => workspacePool },
      instances: {
        findActive: async () => null,
        create: async (input) => {
          Object.assign(instance, input);
          return instance;
        },
        findByIdForUser: async () => instance,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      },
      providers: {
        get: () => ({
          create: async (input: Record<string, unknown>) => {
            providerInput = input;
            return { sandboxId: "provider-sandbox", status: "creating" as const };
          },
          get: async () => null,
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {},
        }),
      } as never,
    });

    await manager.createOrReuse({
      sandboxId: instance.id,
      poolId: "pool_default",
      providerKey: "test-provider",
      userId: instance.userId,
      template: { type: "image", value: "ignored" },
    });

    expect(
      (providerInput?.resources as { volumes: Array<{ name: string; source?: string; target: string }> }).volumes,
    ).toEqual([{ name: "workspace", source: "user_test/ws", target: "/workspace" }]);
  });

  // 修改 Instance 配置后，新的快照仍使用同一用户目录，不能退回到 Sandbox ID。
  test("keeps the stable user workspace path when updating instance config", async () => {
    const instance = makeInstance({
      resolvedConfig: {
        image: "sandbox:test",
        resources: { ...resources, volumes: [{ name: "workspace", source: "user_test/old", target: "/workspace" }] },
        providerExtra: {},
      },
      externalSandboxId: "provider-sandbox",
    });
    let updatedPatch: Record<string, unknown> | undefined;
    const workspacePool = {
      ...pool,
      defaultResources: { ...resources, volumes: [{ name: "workspace", source: "ws", target: "/workspace" }] },
    } as SandboxPool;
    const manager = new SandboxManager({
      pools: { findById: async () => workspacePool },
      instances: {
        findById: async () => instance,
        findByIdForUser: async () => instance,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) => {
          updatedPatch = patch;
          return Object.assign(instance, { status, ...patch });
        },
      } as never,
      providers: {
        get: () => ({
          create: async () => ({ sandboxId: "provider-sandbox", status: "creating" as const }),
          get: async () => null,
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {},
        }),
      } as never,
    });

    await manager.updateInstanceConfig(instance.id, {
      volumes: [{ name: "workspace", source: "/new", target: "/workspace" }],
    });

    expect(
      (
        updatedPatch?.resolvedConfig as {
          resources: { volumes: Array<{ name: string; source?: string; target: string }> };
        }
      ).resources.volumes,
    ).toEqual([{ name: "workspace", source: "user_test/new", target: "/workspace" }]);
  });

  // 根据 Pool 最新默认值 rebuild 时，用户目录路径必须保持稳定。
  test("keeps the stable user workspace path when rebuilding an instance", async () => {
    const instance = makeInstance({
      externalSandboxId: "provider-sandbox",
      resolvedConfig: {
        image: "sandbox:old",
        resources: { ...resources, volumes: [{ name: "workspace", source: "user_test/old", target: "/workspace" }] },
        providerExtra: {},
      },
    });
    let updatedPatch: Record<string, unknown> | undefined;
    const workspacePool = {
      ...pool,
      defaultResources: { ...resources, volumes: [{ name: "workspace", source: "ws", target: "/workspace" }] },
      image: "sandbox:new",
    } as SandboxPool;
    const manager = new SandboxManager({
      pools: { findById: async () => workspacePool },
      instances: {
        findByIdForUser: async () => instance,
        list: async () => [instance],
        update: async (_id: string, status: string, patch?: Record<string, unknown>) => {
          updatedPatch = patch;
          return Object.assign(instance, { status, ...patch });
        },
      } as never,
      providers: {
        get: () => ({
          create: async () => ({ sandboxId: "provider-sandbox", status: "creating" as const }),
          get: async () => null,
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {},
        }),
      } as never,
    });

    await manager.rebuildInstances({ sandboxPoolId: instance.sandboxPoolId, instanceIds: [instance.id] });

    expect(
      (
        updatedPatch?.resolvedConfig as {
          resources: { volumes: Array<{ name: string; source?: string; target: string }> };
        }
      ).resources.volumes,
    ).toEqual([{ name: "workspace", source: "user_test/ws", target: "/workspace" }]);
  });

  // 重试同一 Sandbox 时必须复用已有 machine_id，不能生成第二条 Machine 身份。
  test("reuses the existing machine identity on retry", async () => {
    const existing = makeInstance({ machineId: "mach_original", status: "starting" });
    let createCalled = false;
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => existing,
        findByIdForUser: async () => existing,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(existing, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => {
            createCalled = true;
            throw new Error("unexpected");
          },
          get: async () => null,
          resume: async () => ({ sandboxId: "x", status: "ready" }),
          destroy: async () => {},
        }),
      } as never,
    });

    const result = await manager.createOrReuse({
      sandboxId: "sbi_new-request",
      poolId: "pool_default",
      providerKey: "test-provider",
      userId: "user_test",
      template: { type: "image", value: "ignored" },
    });

    expect(result.machineId).toBe("mach_original");
    expect(createCalled).toBe(false);
  });

  // 主动删除必须按 machine_id 清理连接路由，并删除对应 Instance 记录。
  test("destroys the provider resource and unregisters by machine id", async () => {
    const instance = makeInstance({ externalSandboxId: "provider-sandbox" });
    let destroyed = false;
    let unregistered: string | undefined;
    let deleted: string | undefined;
    stubCoreBootstrap({
      unregisterRemoteNode: (machineId: string) => {
        unregistered = machineId;
      },
    });
    const manager = new SandboxManager({
      instances: {
        findActive: async () => instance,
        findByIdForUser: async () => instance,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
        delete: async (id: string) => {
          deleted = id;
          return instance;
        },
      } as never,
      providers: {
        get: () => ({
          create: async () => ({ sandboxId: "x", status: "creating" }),
          get: async () => null,
          resume: async () => ({ sandboxId: "x", status: "ready" }),
          destroy: async () => {
            destroyed = true;
          },
        }),
      } as never,
    });

    await manager.deleteForUser(instance.id, instance.userId);

    expect(destroyed).toBe(true);
    expect(unregistered).toBe(instance.machineId);
    expect(deleted).toBe(instance.id);
  });

  // FenixAgent 重启后保留 Instance 和 machine_id，仅进入 recovering 等待恢复。
  test("marks active instances recovering after restart", async () => {
    const instance = makeInstance({ status: "ready" });
    let nextStatus: string | undefined;
    const manager = new SandboxManager({
      instances: {
        findActive: async () => instance,
        findByIdForUser: async () => instance,
        list: async () => [instance],
        update: async (_id: string, status: string) => {
          nextStatus = status;
          return Object.assign(instance, { status });
        },
      } as never,
      providers: { get: () => ({}) } as never,
    });

    await manager.recoverAfterRestart();

    expect(nextStatus).toBe("recovering");
    expect(instance.machineId).toBe("mach_sandbox_sbi_test");
  });

  // Pool 默认配置变化后，重建使用原 machine_id，删除 Provider 资源并保存新快照。
  test("rebuilds changed instances without replacing machine identity", async () => {
    const instance = makeInstance({
      externalSandboxId: "provider-sandbox",
      resolvedConfig: {
        image: "sandbox:old",
        providerExtra: {},
        resources: { ...resources, environment: { LANG: "C.UTF-8" } },
      },
    });
    let destroyed = false;
    let updated: { status: string; patch?: Record<string, unknown> } | undefined;
    const manager = new SandboxManager({
      pools: { findById: async () => ({ ...pool, image: "sandbox:new" }) as SandboxPool },
      instances: {
        findActive: async () => instance,
        findByIdForUser: async () => instance,
        list: async () => [instance],
        update: async (_id: string, status: string, patch?: Record<string, unknown>) => {
          updated = { status, patch };
          return Object.assign(instance, { status, ...patch });
        },
      } as never,
      providers: {
        get: () => ({
          create: async () => ({ sandboxId: "x", status: "creating" }),
          get: async () => null,
          resume: async () => ({ sandboxId: "x", status: "ready" }),
          destroy: async () => {
            destroyed = true;
          },
        }),
      } as never,
    });

    const result = await manager.rebuildInstances({ sandboxPoolId: "pool_default", instanceIds: [instance.id] });

    expect(result.items[0].changed).toBe(true);
    expect(destroyed).toBe(true);
    expect(updated?.status).toBe("stopped");
    expect(
      (updated?.patch?.resolvedConfig as { resources: { environment: Record<string, string> } }).resources.environment
        .RCS_MACHINE_ID,
    ).toBe(instance.machineId);
  });

  // dry-run 只返回配置实际发生变化的实例。
  test("dry-run only returns changed instances", async () => {
    const unchanged = makeInstance({
      id: "sbi_unchanged",
      machineId: "mach_sandbox_sbi_unchanged",
      resolvedConfig: {
        image: "sandbox:test",
        resources: {
          ...resources,
          environment: { ...resources.environment, RCS_MACHINE_ID: "mach_sandbox_sbi_unchanged" },
        },
        providerExtra: {},
      },
    });
    const changed = makeInstance({
      id: "sbi_changed",
      resolvedConfig: {
        image: "sandbox:old",
        providerExtra: {},
        resources,
      },
    });
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => null,
        findByIdForUser: async () => null,
        list: async () => [unchanged, changed],
        update: async () => null,
      } as never,
      providers: { get: () => ({}) } as never,
    });

    const result = await manager.rebuildInstances({ sandboxPoolId: "pool_default", dryRun: true });

    expect(result.items.map((item) => item.instanceId)).toEqual(["sbi_changed"]);
  });

  // recovering 实例存在已停止的外部资源时，恢复原资源而不是创建第二个沙盒。
  test("resumes the existing provider resource during recovery", async () => {
    const instance = makeInstance({ status: "recovering", externalSandboxId: "provider-sandbox" });
    let resumed = false;
    let updatedExternalId: string | undefined;
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => instance,
        findByIdForUser: async () => instance,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) => {
          updatedExternalId = patch?.externalSandboxId as string | undefined;
          return Object.assign(instance, { status, ...patch });
        },
      } as never,
      providers: {
        get: () => ({
          create: async () => {
            throw new Error("must not create a second sandbox");
          },
          get: async () => ({ sandboxId: "provider-sandbox", status: "stopped" as const }),
          resume: async () => {
            resumed = true;
            return { sandboxId: "provider-sandbox", status: "ready" as const };
          },
          destroy: async () => {},
        }),
      } as never,
    });

    await manager.createOrReuse({
      sandboxId: instance.id,
      poolId: instance.sandboxPoolId,
      providerKey: instance.providerKey,
      userId: instance.userId,
      template: { type: "image", value: "ignored" },
    });

    expect(resumed).toBe(true);
    expect(updatedExternalId).toBe("provider-sandbox");
  });

  // ACP 等待超时后的重试必须复用现有 Provider 资源，不能因为等待失败就删除并创建第二个资源。
  test("restarts an existing provider resource without destroying it", async () => {
    const instance = makeInstance({ status: "recovering", externalSandboxId: "provider-sandbox" });
    let resumed = false;
    let destroyed = false;
    let created = false;
    const manager = new SandboxManager({
      instances: {
        findActive: async () => instance,
        findById: async () => instance,
        findByIdForUser: async () => instance,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => {
            created = true;
            return { sandboxId: "new-provider-sandbox", status: "creating" as const };
          },
          get: async () => ({ sandboxId: "provider-sandbox", status: "stopped" as const }),
          resume: async () => {
            resumed = true;
            return { sandboxId: "provider-sandbox", status: "ready" as const };
          },
          destroy: async () => {
            destroyed = true;
          },
        }),
      } as never,
    });

    const result = await manager.restart(instance.id);

    expect(result.externalSandboxId).toBe("provider-sandbox");
    expect(resumed).toBe(true);
    expect(created).toBe(false);
    expect(destroyed).toBe(false);
  });

  // ready 实例对应的 Machine 已离线时，业务请求必须重新检查 Provider，而不是直接复用旧状态。
  test("reconciles a ready instance when its machine is offline", async () => {
    const instance = makeInstance({ status: "ready", externalSandboxId: "provider-sandbox" });
    let providerGetCalled = false;
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      isMachineOnline: async () => false,
      instances: {
        findActive: async () => instance,
        findByIdForUser: async () => instance,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => ({ sandboxId: "new-provider-sandbox", status: "creating" as const }),
          get: async () => {
            providerGetCalled = true;
            return { sandboxId: "provider-sandbox", status: "stopped" as const };
          },
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {},
        }),
      } as never,
    });

    await manager.createOrReuse({
      sandboxId: instance.id,
      poolId: instance.sandboxPoolId,
      providerKey: instance.providerKey,
      userId: instance.userId,
      template: { type: "image", value: "ignored" },
    });

    expect(providerGetCalled).toBe(true);
  });

  // Provider 返回 error 时，业务请求必须重建资源，而不是只等待已失效的 ACP 连接。
  test("recreates the provider resource when the existing resource is errored", async () => {
    const instance = makeInstance({
      status: "ready",
      externalSandboxId: "provider-sandbox",
      resolvedConfig: { image: "sandbox:test", resources, providerExtra: {} },
    });
    let destroyed = false;
    let created = false;
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      isMachineOnline: async () => false,
      instances: {
        findActive: async () => instance,
        findByIdForUser: async () => instance,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => {
            created = true;
            return { sandboxId: "new-provider-sandbox", status: "creating" as const };
          },
          get: async () => ({ sandboxId: "provider-sandbox", status: "error" as const }),
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {
            destroyed = true;
          },
        }),
      } as never,
    });

    await manager.createOrReuse({
      sandboxId: instance.id,
      poolId: instance.sandboxPoolId,
      providerKey: instance.providerKey,
      userId: instance.userId,
      template: { type: "image", value: "ignored" },
    });

    expect(destroyed).toBe(true);
    expect(created).toBe(true);
    expect(instance.externalSandboxId).toBe("new-provider-sandbox");
  });
});
