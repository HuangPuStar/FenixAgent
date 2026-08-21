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
        create: async (input: Record<string, unknown>) => {
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
        create: async (input: Record<string, unknown>) => {
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
        providerExtra: {},
        resources: {
          volumes: [],
          environment: { LANG: "C.UTF-8", RCS_MACHINE_ID: "mach_sandbox_sbi_unchanged" },
          gpuCount: 0,
          diskGb: 5,
          memoryMb: 512,
          cpu: 0.5,
        },
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

  // 同一 Instance 的并发 reconcile 必须串行化，避免 Provider 创建出两个外部 Sandbox。
  test("serializes concurrent provider creation for the same sandbox instance", async () => {
    const instance = makeInstance({
      status: "stopped",
      resolvedConfig: { image: "sandbox:test", resources, providerExtra: {} },
    });
    let providerCreateCount = 0;
    let lockTail = Promise.resolve();
    let releaseProvider!: () => void;
    const providerCreated = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => instance,
        findById: async () => instance,
        findByIdForUser: async () => instance,
        withLock: async (_id: string, operation: (locked: Record<string, unknown>) => Promise<SandboxInstance>) => {
          const previous = lockTail;
          let release!: () => void;
          lockTail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          try {
            return await operation({
              findById: async () => instance,
              update: async (_updateId: string, status: string, patch?: Record<string, unknown>) =>
                Object.assign(instance, { status, ...patch }),
            });
          } finally {
            release();
          }
        },
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => {
            providerCreateCount += 1;
            await providerCreated;
            return { sandboxId: "provider-sandbox", status: "creating" as const };
          },
          get: async () => null,
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {},
        }),
      } as never,
    });

    const first = manager.createOrReuse({
      sandboxId: instance.id,
      poolId: instance.sandboxPoolId,
      providerKey: instance.providerKey,
      userId: instance.userId,
      template: { type: "image", value: "ignored" },
    });
    const second = manager.createOrReuse({
      sandboxId: instance.id,
      poolId: instance.sandboxPoolId,
      providerKey: instance.providerKey,
      userId: instance.userId,
      template: { type: "image", value: "ignored" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const providerCreateCountBeforeRelease = providerCreateCount;
    // 释放第一个 Provider 调用，第二个请求随后应观察到已持久化的 externalSandboxId。
    releaseProvider();
    await Promise.all([first, second]);
    expect(providerCreateCountBeforeRelease).toBe(1);
    expect(providerCreateCount).toBe(1);
  });

  // 首次创建必须先抢占 Instance 记录，Machine 和 Provider 资源只能由抢占成功的一方创建。
  test("claims the sandbox instance before creating its machine", async () => {
    const instance = makeInstance({
      status: "creating",
      resolvedConfig: { image: "sandbox:test", resources, providerExtra: {} },
    });
    let claimed = false;
    let machineCreateCount = 0;
    let providerCreateCount = 0;
    let lockTail = Promise.resolve();
    let releaseProvider!: () => void;
    const providerCreated = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    stubRegistry({
      createSandboxMachine: async () => {
        machineCreateCount += 1;
      },
    });

    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => (claimed ? instance : null),
        findById: async () => instance,
        findByIdForUser: async () => instance,
        create: async (input: Record<string, unknown>) => {
          if (claimed) throw { code: "23505", message: "duplicate key" };
          claimed = true;
          Object.assign(instance, input);
          return instance;
        },
        withLock: async (_id: string, operation: (locked: Record<string, unknown>) => Promise<SandboxInstance>) => {
          const previous = lockTail;
          let release!: () => void;
          lockTail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          try {
            return await operation({
              findById: async () => instance,
              update: async (_updateId: string, status: string, patch?: Record<string, unknown>) =>
                Object.assign(instance, { status, ...patch }),
              delete: async () => instance,
            });
          } finally {
            release();
          }
        },
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => {
            providerCreateCount += 1;
            await providerCreated;
            return { sandboxId: "provider-sandbox", status: "creating" as const };
          },
          get: async () => null,
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {},
        }),
      } as never,
    });

    const first = manager.createOrReuse({
      sandboxId: instance.id,
      poolId: instance.sandboxPoolId,
      providerKey: instance.providerKey,
      userId: instance.userId,
      template: { type: "image", value: "ignored" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = manager.createOrReuse({
      sandboxId: "sbi_other-request",
      poolId: instance.sandboxPoolId,
      providerKey: instance.providerKey,
      userId: instance.userId,
      template: { type: "image", value: "ignored" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(machineCreateCount).toBe(1);
    expect(providerCreateCount).toBe(1);
    releaseProvider();
    await Promise.all([first, second]);
    expect(machineCreateCount).toBe(1);
    expect(providerCreateCount).toBe(1);
  });

  // 首次 Instance 抢占遇到唯一约束时，后到请求必须复用抢占成功的一方。
  test("reuses the instance after losing the initial unique claim", async () => {
    const existing = makeInstance({ status: "starting" });
    let findActiveCalls = 0;
    let lockCalls = 0;
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => {
          findActiveCalls += 1;
          return findActiveCalls === 1 ? null : existing;
        },
        create: async () => {
          throw { code: "23505", message: "duplicate key" };
        },
        findByIdForUser: async () => existing,
        withLock: async (_id: string, operation: (scope: Record<string, unknown>) => Promise<SandboxInstance>) => {
          lockCalls += 1;
          return operation({
            findById: async () => existing,
            update: async (_updateId: string, status: string, patch?: Record<string, unknown>) =>
              Object.assign(existing, { status, ...patch }),
            delete: async () => existing,
          });
        },
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(existing, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => {
            throw new Error("must not create a second sandbox");
          },
          get: async () => null,
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {},
        }),
      } as never,
    });

    const result = await manager.createOrReuse({
      sandboxId: "sbi_loser",
      poolId: existing.sandboxPoolId,
      providerKey: existing.providerKey,
      userId: existing.userId,
      template: { type: "image", value: "ignored" },
    });

    expect(result).toBe(existing);
    expect(lockCalls).toBe(1);
  });

  // Machine 初始化失败时，必须删除已抢占的 sandbox_instance，避免留下无法恢复的 creating 记录。
  test("deletes the claimed instance when machine initialization fails", async () => {
    const instance = makeInstance({
      resolvedConfig: { image: "sandbox:test", resources, providerExtra: {} },
    });
    let deleted = false;
    stubRegistry({
      createSandboxMachine: async () => {
        throw new Error("machine insert failed");
      },
    });
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => null,
        create: async (input: Record<string, unknown>) => {
          Object.assign(instance, input);
          return instance;
        },
        findByIdForUser: async () => instance,
        withLock: async (_id: string, operation: (scope: Record<string, unknown>) => Promise<SandboxInstance>) =>
          operation({
            findById: async () => instance,
            update: async (_updateId: string, status: string, patch?: Record<string, unknown>) =>
              Object.assign(instance, { status, ...patch }),
            delete: async () => {
              deleted = true;
              return instance;
            },
          }),
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      } as never,
      providers: { get: () => ({}) } as never,
    });

    await expect(
      manager.createOrReuse({
        sandboxId: instance.id,
        poolId: instance.sandboxPoolId,
        providerKey: instance.providerKey,
        userId: instance.userId,
        template: { type: "image", value: "ignored" },
      }),
    ).rejects.toThrow("machine insert failed");

    expect(deleted).toBe(true);
  });

  // Provider 创建失败时，锁内回写 error，后续请求可以沿原 Instance 重试而不丢失诊断信息。
  test("marks the instance as error when provider creation fails", async () => {
    const instance = makeInstance({
      status: "stopped",
      resolvedConfig: { image: "sandbox:test", resources, providerExtra: {} },
    });
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => instance,
        findByIdForUser: async () => instance,
        withLock: async (_id: string, operation: (scope: Record<string, unknown>) => Promise<SandboxInstance>) =>
          operation({
            findById: async () => instance,
            update: async (_updateId: string, status: string, patch?: Record<string, unknown>) =>
              Object.assign(instance, { status, ...patch }),
            delete: async () => instance,
          }),
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => {
            throw new Error("provider unavailable");
          },
          get: async () => null,
          resume: async () => ({ sandboxId: "provider-sandbox", status: "ready" as const }),
          destroy: async () => {},
        }),
      } as never,
    });

    await expect(
      manager.createOrReuse({
        sandboxId: instance.id,
        poolId: instance.sandboxPoolId,
        providerKey: instance.providerKey,
        userId: instance.userId,
        template: { type: "image", value: "ignored" },
      }),
    ).rejects.toThrow("provider unavailable");

    expect(instance.status).toBe("error");
    expect(instance.providerPayload).toEqual({ message: "provider unavailable" });
  });

  // Provider create 返回 stopped 时，必须在同一 Instance 上 resume，而不是再次 create。
  test("resumes a stopped provider resource returned by create", async () => {
    const instance = makeInstance({
      status: "stopped",
      resolvedConfig: { image: "sandbox:test", resources, providerExtra: {} },
    });
    let resumed = false;
    const manager = new SandboxManager({
      pools: { findById: async () => pool },
      instances: {
        findActive: async () => instance,
        findByIdForUser: async () => instance,
        withLock: async (_id: string, operation: (scope: Record<string, unknown>) => Promise<SandboxInstance>) =>
          operation({
            findById: async () => instance,
            update: async (_updateId: string, status: string, patch?: Record<string, unknown>) =>
              Object.assign(instance, { status, ...patch }),
            delete: async () => instance,
          }),
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => ({ sandboxId: "provider-sandbox", status: "stopped" as const }),
          get: async () => null,
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
    expect(instance.externalSandboxId).toBe("provider-sandbox");
  });

  // recover 重建必须复用同一行锁，避免与普通启动请求交叉销毁并创建 Provider 资源。
  test("locks the provider recreation path during recover", async () => {
    const instance = makeInstance({
      status: "ready",
      externalSandboxId: "old-provider-sandbox",
      resolvedConfig: { image: "sandbox:test", resources, providerExtra: {} },
    });
    let lockCalls = 0;
    let destroyed = false;
    let created = false;
    const manager = new SandboxManager({
      instances: {
        findById: async () => instance,
        findByIdForUser: async () => instance,
        withLock: async (_id: string, operation: (scope: Record<string, unknown>) => Promise<SandboxInstance>) => {
          lockCalls += 1;
          return operation({
            findById: async () => instance,
            update: async (_updateId: string, status: string, patch?: Record<string, unknown>) =>
              Object.assign(instance, { status, ...patch }),
            delete: async () => instance,
          });
        },
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(instance, { status, ...patch }),
      } as never,
      providers: {
        get: () => ({
          create: async () => {
            created = true;
            return { sandboxId: "new-provider-sandbox", status: "creating" as const };
          },
          get: async () => null,
          resume: async () => ({ sandboxId: "new-provider-sandbox", status: "ready" as const }),
          destroy: async () => {
            destroyed = true;
          },
        }),
      } as never,
    });

    await manager.recover(instance.id);

    expect(lockCalls).toBe(1);
    expect(destroyed).toBe(true);
    expect(created).toBe(true);
    expect(instance.externalSandboxId).toBe("new-provider-sandbox");
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
