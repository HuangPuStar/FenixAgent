import { afterEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { SandboxManager } from "@fenix/resource-sandbox/server";
import { makeInstance, pool, resources } from "./sandbox-manager-fixtures";

describe("SandboxManager resource recovery", () => {
  afterEach(() => {
    resetAllStubs();
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
