import { afterEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { SandboxManager } from "@fenix/resource-sandbox/server";
import { makeInstance, pool, resources } from "./sandbox-manager-fixtures";

describe("SandboxManager concurrency", () => {
  afterEach(() => {
    resetAllStubs();
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
    const manager = new SandboxManager({
      createMachine: async () => {
        machineCreateCount += 1;
      },
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
      organizationId: "org-second",
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
    const manager = new SandboxManager({
      createMachine: async () => {
        throw new Error("machine insert failed");
      },
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
});
