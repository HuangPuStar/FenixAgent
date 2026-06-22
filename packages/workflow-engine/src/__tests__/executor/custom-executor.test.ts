/**
 * CustomNodeExecutor 测试 — 重点覆盖事件发射契约（node.started/completed/failed）
 * 与失败时 stderr 透传到事件 metadata（修复前端"事件流为空 + 输出 0B"问题）。
 */

import { describe, expect, test } from "bun:test";
import { CustomNodeExecutor } from "../../plugins/custom-executor";
import { CustomNodeRegistry } from "../../plugins/registry";
import type { CustomNode, ExecuteContext } from "../../plugins/types";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { CustomNodeDef } from "../../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";
import type { NodeOutput } from "../../types/execution";

// ---------- 辅助工具 ----------

function makeCtx(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const storage = createInMemoryStorage();
  return {
    runId: "test-run-001",
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: AbortSignal.timeout(30_000),
    storage,
    ...overrides,
  };
}

function customNode(tool: string, overrides?: Partial<CustomNodeDef>): CustomNodeDef {
  return {
    id: "test-node",
    type: "custom",
    tool,
    ...overrides,
  };
}

/** 构造一个 fake CustomNode，execute 返回固定输出或抛指定错误 */
function makeFakeTool(opts: { name: string; executeFn: (ctx: ExecuteContext) => Promise<NodeOutput> }): CustomNode {
  return {
    name: opts.name,
    description: `fake tool ${opts.name}`,
    inputs: {},
    produces: [],
    execute: opts.executeFn,
  };
}

// ========== 成功路径：事件发射 ==========

describe("CustomNodeExecutor 成功路径", () => {
  test("发射 node.started + node.completed 事件", async () => {
    const registry = new CustomNodeRegistry();
    registry.register(
      makeFakeTool({
        name: "ok_tool",
        executeFn: async () => ({ stdout: "done", exit_code: 0, size: 4 }),
      }),
    );
    const executor = new CustomNodeExecutor(registry);

    const ctx = makeCtx();
    const node = customNode("ok_tool");

    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-node" });
    const types = events.map((e) => e.type);

    expect(types).toContain("node.started");
    expect(types).toContain("node.completed");
    expect(types).not.toContain("node.failed");
  });

  test("node.completed metadata 含 exit_code 与 output_size", async () => {
    const registry = new CustomNodeRegistry();
    registry.register(
      makeFakeTool({
        name: "ok_tool",
        executeFn: async () => ({ stdout: "hello world", exit_code: 0, size: 11 }),
      }),
    );
    const executor = new CustomNodeExecutor(registry);

    const ctx = makeCtx();
    await executor.execute(customNode("ok_tool"), ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-node" });
    const completed = events.find((e) => e.type === "node.completed");
    expect(completed?.metadata?.exit_code).toBe(0);
    expect(completed?.metadata?.output_size).toBe(11);
  });
});

// ========== 失败路径：stderr 透传到事件 ==========

describe("CustomNodeExecutor 失败路径", () => {
  // 关键回归：失败时 stderr 必须进入 node.failed 事件 metadata，
  // 否则前端只能看到 "exit_code: 1 / 0B 输出"，完全不知道脚本里哪条命令挂了。
  test("WorkflowError 的 stderr/stdout/exit_code 透传到 node.failed metadata", async () => {
    const registry = new CustomNodeRegistry();
    registry.register(
      makeFakeTool({
        name: "fail_tool",
        executeFn: async () => {
          throw new WorkflowError("Slurm job 999 failed with state FAILED", WorkflowErrorCode.NODE_FAILED, {
            node_id: "test-node",
            slurm_job_id: "999",
            exit_code: 1,
            stdout: "step 1 ok\nstep 2 ok",
            stderr: "apptainer: SIF not found at /path/to.sif",
          });
        },
      }),
    );
    const executor = new CustomNodeExecutor(registry);

    const ctx = makeCtx();
    await expect(executor.execute(customNode("fail_tool"), ctx)).rejects.toThrow(/Slurm job 999 failed/);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-node" });
    const failed = events.find((e) => e.type === "node.failed");
    expect(failed).toBeDefined();
    expect(failed?.metadata?.error).toBe("Slurm job 999 failed with state FAILED");
    expect(failed?.metadata?.exit_code).toBe(1);
    expect(failed?.metadata?.stderr).toBe("apptainer: SIF not found at /path/to.sif");
    expect(failed?.metadata?.stdout).toBe("step 1 ok\nstep 2 ok");
    expect(failed?.metadata?.slurm_job_id).toBe("999");
  });

  test("tool 不存在时发射 node.failed 事件（含 error 字段）", async () => {
    const registry = new CustomNodeRegistry();
    const executor = new CustomNodeExecutor(registry);

    const ctx = makeCtx();
    await expect(executor.execute(customNode("missing_tool"), ctx)).rejects.toThrow(/not registered/);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-node" });
    const failed = events.find((e) => e.type === "node.failed");
    expect(failed).toBeDefined();
    expect(String(failed?.metadata?.error ?? "")).toContain("not registered");
    expect(failed?.metadata?.tool).toBe("missing_tool");
  });

  test("非 WorkflowError 异常也发射 node.failed（error 字段填 message）", async () => {
    const registry = new CustomNodeRegistry();
    registry.register(
      makeFakeTool({
        name: "explode",
        executeFn: async () => {
          throw new Error("unexpected kaboom");
        },
      }),
    );
    const executor = new CustomNodeExecutor(registry);

    const ctx = makeCtx();
    await expect(executor.execute(customNode("explode"), ctx)).rejects.toThrow(/unexpected kaboom/);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-node" });
    const failed = events.find((e) => e.type === "node.failed");
    expect(failed?.metadata?.error).toBe("unexpected kaboom");
    expect(failed?.metadata?.exit_code).toBe(1);
  });
});

// ========== onCleanup 钩子 ==========

describe("CustomNodeExecutor onCleanup", () => {
  test("成功时调用 onCleanup(result, null)", async () => {
    let cleanupCalled = false;
    let cleanupGotResult: NodeOutput | null = null;
    let cleanupGotError: Error | null = new Error("placeholder");
    const registry = new CustomNodeRegistry();
    registry.register({
      name: "with_cleanup",
      description: "tool with cleanup",
      inputs: {},
      produces: [],
      execute: async () => ({ stdout: "ok", exit_code: 0, size: 2 }),
      onCleanup: async (_ctx, result, error) => {
        cleanupCalled = true;
        cleanupGotResult = result;
        cleanupGotError = error;
      },
    });
    const executor = new CustomNodeExecutor(registry);

    await executor.execute(customNode("with_cleanup"), makeCtx());

    expect(cleanupCalled).toBe(true);
    expect(cleanupGotResult?.exit_code).toBe(0);
    expect(cleanupGotError).toBeNull();
  });

  test("失败时也调用 onCleanup(null, error)", async () => {
    let cleanupGotError: Error | null = null;
    const registry = new CustomNodeRegistry();
    registry.register({
      name: "fail_with_cleanup",
      description: "tool that fails with cleanup",
      inputs: {},
      produces: [],
      execute: async () => {
        throw new Error("boom");
      },
      onCleanup: async (_ctx, _result, error) => {
        cleanupGotError = error;
      },
    });
    const executor = new CustomNodeExecutor(registry);

    await expect(executor.execute(customNode("fail_with_cleanup"), makeCtx())).rejects.toThrow(/boom/);
    expect(cleanupGotError?.message).toContain("boom");
  });
});

// ========== script 字段透传(SlurmNode 子类场景) ==========

// executor 把调度器求值后的 resolvedInputs.script 透传到 ExecuteContext.script,
// SlurmNode.buildScript / generateHeader 通过此字段读取脚本内容与环境变量。

test("executor 把 resolvedInputs.script 透传到 ExecuteContext.script", async () => {
  const registry = new CustomNodeRegistry();
  let capturedCtx: ExecuteContext | null = null;
  registry.register({
    name: "fake_slurm",
    description: "fake slurm tool",
    inputs: {},
    produces: ["*"],
    kind: "slurm",
    execute: async (ctx) => {
      capturedCtx = ctx;
      return { stdout: "ok", exit_code: 0, size: 2 };
    },
  } as unknown as CustomNode);

  const executor = new CustomNodeExecutor(registry);
  const ctx = makeCtx({
    resolvedInputs: {
      script: {
        content: "echo hello",
        env: { WORK_DIR: "/data", CORES: "8" },
      },
    },
  });
  const node = customNode("fake_slurm", {
    script: { content: "echo hello", env: { WORK_DIR: "/data" } },
  });

  await executor.execute(node, ctx);

  expect(capturedCtx).not.toBeNull();
  expect(capturedCtx!.script).toBeDefined();
  expect(capturedCtx!.script?.content).toBe("echo hello");
  expect(capturedCtx!.script?.env.WORK_DIR).toBe("/data");
  expect(capturedCtx!.script?.env.CORES).toBe("8");
});

test("非 slurm 工具的 ExecuteContext.script 为 undefined", async () => {
  const registry = new CustomNodeRegistry();
  let capturedCtx: ExecuteContext | null = null;
  registry.register(
    makeFakeTool({
      name: "plain_tool",
      executeFn: async (ctx) => {
        capturedCtx = ctx;
        return { stdout: "ok", exit_code: 0, size: 2 };
      },
    }),
  );

  const executor = new CustomNodeExecutor(registry);
  const ctx = makeCtx(); // resolvedInputs 不含 script
  const node = customNode("plain_tool");

  await executor.execute(node, ctx);

  expect(capturedCtx).not.toBeNull();
  expect(capturedCtx!.script).toBeUndefined();
});
