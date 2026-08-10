import { afterEach, expect, test } from "bun:test";
import { SandboxExecutionHandler } from "../services/sandbox/sandbox-execution-handler";
import { resetAllStubs } from "../test-utils/helpers";

afterEach(() => {
  resetAllStubs();
});

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
    restart: async () => {
      restartCalled = true;
      online = true;
      return { id: "sbi_recover", machineId: "mach_sandbox_sbi_recover", status: "starting" };
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
      runtimeConnectTimeoutMs: 1,
    } as never),
  ).resolves.toMatchObject({ nodeId: "mach_sandbox_sbi_recover" });

  expect(restartCalled).toBe(true);
  expect(recoverCalled).toBe(false);
  expect(reads).toBeGreaterThanOrEqual(1);
});

// 原 Provider 资源无法恢复且再次等待仍失败时，才销毁旧资源并重建。
test("recreates the sandbox when retrying the existing provider resource fails", async () => {
  let restartCalled = false;
  let recoverCalled = false;
  let online = false;
  const manager = {
    getPool: async () => ({ id: "pool_default", providerKey: "test-provider", image: "sandbox:test" }),
    createOrReuse: async () => ({ id: "sbi_rebuild", machineId: "mach_sandbox_sbi_rebuild", status: "starting" }),
    restart: async () => {
      restartCalled = true;
      throw new Error("provider resource is not recoverable");
    },
    recover: async () => {
      recoverCalled = true;
      online = true;
      return { id: "sbi_rebuild", machineId: "mach_sandbox_sbi_rebuild", status: "starting" };
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
      runtimeConnectTimeoutMs: 1,
    } as never),
  ).resolves.toMatchObject({ nodeId: "mach_sandbox_sbi_rebuild" });

  expect(restartCalled).toBe(true);
  expect(recoverCalled).toBe(true);
});
