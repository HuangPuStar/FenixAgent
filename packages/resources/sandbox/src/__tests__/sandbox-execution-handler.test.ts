import { afterEach, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { SandboxExecutionHandler } from "@fenix/resource-sandbox/server";

afterEach(() => {
  resetAllStubs();
});

/**
 * 补偿路径用例的连接等待超时：首次等待必须超时（readOnline 初始 false），重试后的等待必须成功。
 * 两次等待共用此值——1ms 时"成功"那次只剩 1ms 判定窗口，负载下会被调度抖动吃掉而让补偿多走一级
 * （recover 被意外调用，与 `round37-service-boundaries.test.ts` 在 CI 上的偶发失败同根因）；
 * 50ms 足以覆盖判定路径（入口检查 + 一次 readOnline 微任务）。
 */
const CONNECT_TIMEOUT_MS = 50;

// Sandbox 启动等待 Machine online 后，寻址节点必须返回 machine_id。
test("waits for the machine to become online and returns its id", async () => {
  const manager = {
    getPool: async () => ({ id: "pool_default", providerKey: "test-provider", image: "sandbox:test" }),
    createOrReuse: async () => ({ id: "sbi_test", machineId: "mach_sandbox_sbi_test", status: "starting" }),
    markError: async () => {
      throw new Error("must not be called");
    },
  } as never;
  const handler = new SandboxExecutionHandler(manager, async () => true);

  const preparing = handler.prepare({
    sandboxId: "sbi_test",
    sandboxPoolId: "pool_default",
    providerKey: "ignored",
    userId: "user_test",
    template: { type: "image", value: "ignored" },
    runtimeConnectTimeoutMs: 1000,
  } as never);
  await expect(preparing).resolves.toEqual({
    nodeId: "mach_sandbox_sbi_test",
    source: "sandbox",
    sandboxId: "sbi_test",
  });
});

// Machine 已经 online 时，准备流程必须立即复用当前连接。
test("accepts a machine that is already online", async () => {
  const manager = {
    getPool: async () => ({ id: "pool_default", providerKey: "test-provider", image: "sandbox:test" }),
    createOrReuse: async () => ({ id: "sbi_early", machineId: "mach_sandbox_sbi_early", status: "starting" }),
    markError: async () => {
      throw new Error("must not be called");
    },
  } as never;
  const handler = new SandboxExecutionHandler(manager, async () => true);

  await expect(
    handler.prepare({
      sandboxId: "sbi_early",
      sandboxPoolId: "pool_default",
      providerKey: "ignored",
      userId: "user_test",
      template: { type: "image", value: "ignored" },
      runtimeConnectTimeoutMs: 1000,
    } as never),
  ).resolves.toEqual({
    nodeId: "mach_sandbox_sbi_early",
    source: "sandbox",
    sandboxId: "sbi_early",
  });
});

// ACP 首次等待超时后，优先复用原 Provider 资源重试，而不是立即销毁重建。
test("retries the existing provider resource after the first ACP timeout", async () => {
  let restartCalled = false;
  let recoverCalled = false;
  let online = false;
  const manager = {
    getPool: async () => ({ id: "pool_default", providerKey: "test-provider", image: "sandbox:test" }),
    createOrReuse: async () => ({ id: "sbi_recover", machineId: "mach_sandbox_sbi_recover", status: "starting" }),
    repairRuntime: async (_id: string, options: { recreate?: boolean }) => {
      restartCalled = true;
      recoverCalled = Boolean(options.recreate);
      online = true;
      return {
        instance: { id: "sbi_recover", machineId: "mach_sandbox_sbi_recover", status: "starting" },
        replaced: false,
      };
    },
    recover: async () => {
      recoverCalled = true;
      return { id: "sbi_recover", machineId: "mach_sandbox_sbi_recover", status: "starting" };
    },
    markError: async () => {
      throw new Error("must not be called");
    },
  } as never;
  let reads = 0;
  const handler = new SandboxExecutionHandler(manager, async () => {
    reads += 1;
    return online;
  });

  await expect(
    handler.prepare({
      sandboxId: "sbi_recover",
      sandboxPoolId: "pool_default",
      providerKey: "ignored",
      userId: "user_test",
      template: { type: "image", value: "ignored" },
      runtimeConnectTimeoutMs: CONNECT_TIMEOUT_MS,
    } as never),
  ).resolves.toMatchObject({ nodeId: "mach_sandbox_sbi_recover" });

  expect(restartCalled).toBe(true);
  expect(recoverCalled).toBe(false);
  expect(reads).toBeGreaterThanOrEqual(1);
});

// 原 Provider 资源无法恢复且再次等待仍失败时，才销毁旧资源并重建。
test("recreates the sandbox after the existing resource stays disconnected", async () => {
  let restartCalled = false;
  let recoverCalled = false;
  let online = false;
  const manager = {
    getPool: async () => ({ id: "pool_default", providerKey: "test-provider", image: "sandbox:test" }),
    createOrReuse: async () => ({ id: "sbi_rebuild", machineId: "mach_sandbox_sbi_rebuild", status: "starting" }),
    repairRuntime: async (_id: string, options: { recreate?: boolean }) => {
      if (options.recreate) {
        recoverCalled = true;
        online = true;
      } else restartCalled = true;
      return {
        instance: { id: "sbi_rebuild", machineId: "mach_sandbox_sbi_rebuild", status: "starting" },
        replaced: Boolean(options.recreate),
      };
    },
    markError: async () => {
      throw new Error("must not be called");
    },
  } as never;
  const handler = new SandboxExecutionHandler(manager, async () => online);

  await expect(
    handler.prepare({
      sandboxId: "sbi_rebuild",
      sandboxPoolId: "pool_default",
      providerKey: "ignored",
      userId: "user_test",
      template: { type: "image", value: "ignored" },
      runtimeConnectTimeoutMs: CONNECT_TIMEOUT_MS,
    } as never),
  ).resolves.toMatchObject({ nodeId: "mach_sandbox_sbi_rebuild" });

  expect(restartCalled).toBe(true);
  expect(recoverCalled).toBe(true);
});
