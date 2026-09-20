import { afterEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { SandboxManager } from "@fenix/resource-sandbox/server";
import { makeInstance, pool, resources } from "./sandbox-manager-fixtures";

describe("SandboxManager machine identity", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 新建 Instance 必须先绑定稳定的 machine_id，并把它注入 Provider 配置环境变量。
  test("creates a machine identity and passes RCS_MACHINE_ID to the provider", async () => {
    let machineInput: Record<string, unknown> | undefined;
    let providerInput: Record<string, unknown> | undefined;
    const instance = makeInstance({ resolvedConfig: undefined as never });
    const manager = new SandboxManager({
      createMachine: async (input) => {
        machineInput = input;
      },
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
      organizationId: "org-second",
      template: { type: "image", value: "ignored" },
    });

    expect(machineInput).toMatchObject({
      id: "mach_sandbox_sbi_test",
      organizationId: null,
      userId: "user_test",
    });
    expect(instance.machineId).toBe("mach_sandbox_sbi_test");
    expect((providerInput?.resources as { environment: Record<string, string> }).environment.RCS_MACHINE_ID).toBe(
      "mach_sandbox_sbi_test",
    );
  });

  // Sandbox 按用户和资源池复用；切换组织时应沿用已有实例。
  test("reuses a user sandbox across organizations", async () => {
    const existing = makeInstance({ status: "starting" });
    const readablePoolLookups: Array<{ poolId: string; organizationId: string }> = [];
    const manager = new SandboxManager({
      pools: {
        findById: async () => pool,
        findReadableById: async (poolId, organizationId) => {
          readablePoolLookups.push({ poolId, organizationId });
          return pool;
        },
      },
      instances: {
        findActive: async () => existing,
        findByIdForUser: async () => existing,
        update: async (_id: string, status: string, patch?: Record<string, unknown>) =>
          Object.assign(existing, { status, ...patch }),
      } as never,
      providers: { get: () => ({}) } as never,
    });

    const result = await manager.createOrReuse({
      sandboxId: "sbi_other_org",
      poolId: existing.sandboxPoolId,
      providerKey: existing.providerKey,
      userId: existing.userId,
      organizationId: "org-second",
      template: { type: "image", value: "ignored" },
    });

    expect(result).toBe(existing);
    expect(readablePoolLookups).toEqual([{ poolId: existing.sandboxPoolId, organizationId: "org-second" }]);
  });

  // 跨组织复用不绕过资源池可见性；目标组织不可读时不得查询或复用用户的 Sandbox。
  test("rejects cross-organization reuse when the sandbox pool is not readable", async () => {
    let findActiveCalls = 0;
    const manager = new SandboxManager({
      pools: {
        findById: async () => pool,
        findReadableById: async () => null,
      },
      instances: {
        findActive: async () => {
          findActiveCalls += 1;
          return makeInstance();
        },
        findByIdForUser: async () => null,
        update: async () => null,
      } as never,
      providers: { get: () => ({}) } as never,
    });

    await expect(
      manager.createOrReuse({
        sandboxId: "sbi_hidden_pool",
        poolId: "pool_default",
        providerKey: "test-provider",
        userId: "user_test",
        organizationId: "org-second",
        template: { type: "image", value: "ignored" },
      }),
    ).rejects.toThrow("sandbox pool 'pool_default' not found");

    expect(findActiveCalls).toBe(0);
  });

  // 创建 Sandbox Machine 时应使用资源池声明的 Agent 类型，而不是固定写入 opencode。
  test("uses the agent type configured by the sandbox pool", async () => {
    let machineInput: Record<string, unknown> | undefined;
    const periPool = { ...pool, extra: { agent_type: "peri" } } as SandboxPool;
    const instance = makeInstance({ resolvedConfig: undefined as never });
    const manager = new SandboxManager({
      createMachine: async (input) => {
        machineInput = input;
      },
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
      createMachine: async () => {},
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
    const manager = new SandboxManager({
      // 释放路由的能力由 Machine 资源提供：真实实现走 agent-runtime 的 core runtime 端口，
      // 这里只断言 Sandbox 确实按 machine_id 发起了释放。
      releaseRuntime: (machineId: string) => {
        unregistered = machineId;
      },
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
});
