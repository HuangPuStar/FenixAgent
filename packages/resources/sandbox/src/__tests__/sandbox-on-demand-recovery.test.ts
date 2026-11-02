import { describe, expect, test } from "bun:test";
import type { SandboxInstanceLockScope } from "../server/repositories/sandbox-instance-repository";
import { SandboxExecutionHandler } from "../server/services/sandbox-execution-handler";
import { SandboxManager } from "../server/services/sandbox-manager";
import { SandboxProviderRegistry } from "../server/services/sandbox-provider-registry";
import { makeInstance, pool, resources } from "./sandbox-manager-fixtures";

/** 仅替换外部 Provider 和数据库，保留 Manager 与恢复编排的真实行为。 */
function fixture() {
  let row = makeInstance({
    status: "ready",
    externalSandboxId: "old",
    resolvedConfig: { image: "sandbox:test", resources, providerExtra: {} },
  });
  let online = false;
  let createOnline = true;
  let resumeOnline = true;
  let status: "ready" | "stopped" | "error" | "missing" = "ready";
  let failure: Error | undefined;
  let createFailure: Error | undefined;
  let destroyFailure: Error | undefined;
  const events: string[] = [];
  let beforeGet = async () => {};
  const registry = new SandboxProviderRegistry();
  registry.register("test-provider", {
    async get() {
      events.push("get");
      await beforeGet();
      if (failure) throw failure;
      return status === "missing" ? null : { sandboxId: row.externalSandboxId!, status };
    },
    async resume() {
      events.push("resume");
      online = resumeOnline;
      return { sandboxId: "old", status: "ready" };
    },
    async destroy() {
      events.push("destroy");
      if (destroyFailure) throw destroyFailure;
    },
    async create() {
      events.push("create");
      if (createFailure) throw createFailure;
      online = createOnline;
      return { sandboxId: "new", status: "ready" };
    },
  });
  const update: SandboxInstanceLockScope["update"] = async (_id, nextStatus, patch) => {
    row = { ...row, status: nextStatus, ...patch };
    return row;
  };
  const scope: SandboxInstanceLockScope = { findById: async () => row, update, delete: async () => row };
  let lock = Promise.resolve();
  const manager = new SandboxManager({
    pools: { findById: async () => pool },
    instances: {
      findActive: async () => row,
      findById: async () => row,
      findByMachineId: async (id) => (id === row.machineId ? row : null),
      findByIdForUser: async (_id, userId) => (userId === row.userId ? row : null),
      create: async () => row,
      update,
      async withLock(_id, operation) {
        const previous = lock;
        let release = () => {};
        lock = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        const saved = { ...row };
        try {
          return await operation(scope);
        } catch (error) {
          row = saved;
          throw error;
        } finally {
          release();
        }
      },
    },
    providers: registry,
    isMachineOnline: async () => online,
    releaseRuntime() {
      events.push("release");
    },
  });
  const handler = new SandboxExecutionHandler(manager, async () => online);
  const input = {
    machineId: row.machineId,
    ownerUserId: row.userId,
    isCurrent: () => true,
    runtimeConnectTimeoutMs: 20,
  };
  return {
    manager,
    handler,
    input,
    events,
    setResumeOnline: (value: boolean) => {
      resumeOnline = value;
    },
    setCreateOnline: (value: boolean) => {
      createOnline = value;
    },
    row: () => row,
    setStatus: (v: typeof status) => {
      status = v;
    },
    setFailure: (v?: Error) => {
      failure = v;
    },
    setDestroyFailure: (value: Error) => {
      destroyFailure = value;
    },
    setCreateFailure: (v?: Error) => {
      createFailure = v;
    },
    setBeforeGet: (v: () => Promise<void>) => {
      beforeGet = v;
    },
    setOnline: () => {
      online = true;
    },
    replace: () => {
      row = { ...row, externalSandboxId: "other" };
    },
  };
}

describe("sandbox on-demand recovery", () => {
  // 假健康沙盒的并发进入只允许一次销毁重建，清理旧 runtime 必须先于创建。
  test("shares one recovery round and releases old runtime before replacement", async () => {
    const f = fixture();
    await Promise.all([f.handler.recoverDisconnectedMachine(f.input), f.handler.recoverDisconnectedMachine(f.input)]);
    expect(f.events).toEqual(["get", "get", "destroy", "release", "create"]);
    expect(f.row().externalSandboxId).toBe("new");
  });

  // OOM 后停止的资源优先恢复，不能无条件销毁。
  test("resumes a stopped sandbox", async () => {
    const f = fixture();
    f.setStatus("stopped");
    await f.handler.recoverDisconnectedMachine(f.input);
    expect(f.events).toEqual(["get", "resume"]);
  });

  // 查询异常不是资源不存在，失败后下一次进入仍能重试。
  test("preserves provider failures without destroying and releases failed rounds", async () => {
    const f = fixture();
    const error = new Error("provider timeout");
    f.setFailure(error);
    await expect(f.handler.recoverDisconnectedMachine(f.input)).rejects.toBe(error);
    expect(f.events).toEqual(["get"]);
    expect(f.row().externalSandboxId).toBe("old");
    expect(f.row().status).toBe("error");
    f.setFailure();
    f.setStatus("stopped");
    await f.handler.recoverDisconnectedMachine(f.input);
    expect(f.events).toEqual(["get", "get", "resume"]);
  });

  // 普通机器和其他用户不能借此触发沙盒创建或销毁。
  test("does not recover unmanaged or foreign machines", async () => {
    const f = fixture();
    await f.handler.recoverDisconnectedMachine({ ...f.input, machineId: "ordinary" });
    await f.handler.recoverDisconnectedMachine({ ...f.input, ownerUserId: "another-user" });
    expect(f.events).toEqual([]);
  });

  // 清理旧 runtime 不依赖新资源创建成功，创建错误必须提交并保留原始异常。
  test("settles a missing resource before creation failure", async () => {
    const f = fixture();
    f.setStatus("missing");
    const error = new Error("create failed");
    f.setCreateFailure(error);
    await expect(f.handler.recoverDisconnectedMachine(f.input)).rejects.toBe(error);
    expect(f.events).toEqual(["get", "release", "create"]);
    expect(f.row().status).toBe("error");
    expect(f.row().externalSandboxId).toBeNull();
  });

  // Provider 查询期间停止使旧意图过期，不能继续执行破坏性操作。
  test("rechecks intent after querying the provider", async () => {
    const f = fixture();
    let current = true;
    f.setBeforeGet(async () => {
      current = false;
    });
    await expect(f.handler.recoverDisconnectedMachine({ ...f.input, isCurrent: () => current })).rejects.toThrow();
    expect(f.events).toEqual(["get"]);
  });

  // 等待旧资源超时后，行锁内复查必须保护已被其他请求替换的资源。
  test("does not recreate a different resource after a stale timeout", async () => {
    const f = fixture();
    f.replace();
    await f.manager.repairRuntime(f.row().id, {
      recreate: true,
      expectedExternalSandboxId: "old",
      isCurrent: () => true,
    });
    expect(f.events).toEqual([]);
  });
});

// 普通 prepare 已经替换过旧资源时，ACP 超时不能在同一请求内连续重建。
test("does not replace twice when initial reconciliation already replaced the resource", async () => {
  const f = fixture();
  f.setStatus("missing");
  f.setCreateOnline(false);
  const handler = new SandboxExecutionHandler(f.manager, async () => false);
  await expect(
    handler.prepare({
      sandboxId: "sbi_test",
      sandboxPoolId: "pool_default",
      userId: "user_test",
      runtimeConnectTimeoutMs: 20,
    }),
  ).rejects.toThrow("not ready");
  expect(f.events.filter((event) => event === "create")).toHaveLength(1);
});

// 一名等待者取消只能结束自身请求，其余等待者仍共享同一恢复结果。
test("cancels one waiter without cancelling the shared recovery", async () => {
  const f = fixture();
  f.setStatus("stopped");
  const queried = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  f.setBeforeGet(async () => {
    queried.resolve();
    await proceed.promise;
  });
  const controller = new AbortController();
  const first = f.handler.recoverDisconnectedMachine({ ...f.input, signal: controller.signal });
  const second = f.handler.recoverDisconnectedMachine(f.input);
  await queried.promise;
  const cancelled = first.catch((error: unknown) => error);
  controller.abort(new Error("cancelled"));
  expect(await cancelled).toEqual(new Error("cancelled"));
  proceed.resolve();
  await second;
  expect(f.events).toEqual(["get", "resume"]);
});

// 查询期间已恢复的连接直接复用，避免短暂断网触发容器重建。
test("reuses a connection that recovers while the provider query is in flight", async () => {
  const f = fixture();
  f.setBeforeGet(async () => {
    f.setOnline();
  });
  await f.handler.recoverDisconnectedMachine(f.input);
  expect(f.events).toEqual(["get"]);
});

// clean-slate 先于查询返回时，旧恢复意图会正常失效，必须认可已就绪连接而不是报错或降级。
test("accepts clean-slate readiness even when it invalidates the recovery context", async () => {
  const f = fixture();
  let current = true;
  f.setBeforeGet(async () => {
    f.setOnline();
    current = false;
  });
  await f.handler.recoverDisconnectedMachine({ ...f.input, isCurrent: () => current });
  expect(f.events).toEqual(["get"]);
  expect(f.row().status).toBe("ready");
});

// 初始协调已经 resume 时，连接持续超时应重建一次，而不是重复 resume 同一资源。
test("does not resume twice during ordinary preparation", async () => {
  const f = fixture();
  f.setStatus("stopped");
  f.setResumeOnline(false);
  await f.handler.prepare({
    sandboxId: "sbi_test",
    sandboxPoolId: "pool_default",
    userId: "user_test",
    runtimeConnectTimeoutMs: 20,
  });
  expect(f.events.filter((event) => event === "resume")).toHaveLength(1);
  expect(f.events.filter((event) => event === "create")).toHaveLength(1);
});

// 销毁失败不构成确定终止，不能提前释放配额或创建第二个容器。
test("keeps the original runtime attribution when destruction fails", async () => {
  const f = fixture();
  f.setStatus("error");
  const error = new Error("destroy failed");
  f.setDestroyFailure(error);
  await expect(f.handler.recoverDisconnectedMachine(f.input)).rejects.toBe(error);
  expect(f.events).toEqual(["get", "destroy"]);
  expect(f.row().externalSandboxId).toBe("old");
});

// 替换资源创建失败后，下一次请求必须能重试，不保留失败 Promise 或旧资源引用。
test("retries after replacement creation failed", async () => {
  const f = fixture();
  f.setStatus("missing");
  f.setCreateFailure(new Error("create failed"));
  await expect(f.handler.recoverDisconnectedMachine(f.input)).rejects.toThrow("create failed");
  f.setCreateFailure();
  await f.handler.recoverDisconnectedMachine(f.input);
  expect(f.events).toEqual(["get", "release", "create", "release", "create"]);
  expect(f.row().externalSandboxId).toBe("new");
});
