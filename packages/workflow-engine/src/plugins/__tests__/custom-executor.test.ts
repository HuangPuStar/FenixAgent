import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { StorageAdapter } from "../../storage/storage-adapter";
import { WorkflowError } from "../../types/errors";
import type { NodeOutput } from "../../types/execution";
import { CustomNodeExecutor } from "../custom-executor";
import { CustomNodeRegistry } from "../registry";
import type { CustomNode, ExecuteContext } from "../types";

/** 创建最小 NodeExecutionContext */
function createTestCtx(overrides?: Record<string, unknown>): {
  runId: string;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  resolvedInputs: Record<string, unknown>;
  signal: AbortSignal;
  storage: StorageAdapter;
} {
  return {
    runId: "run_test",
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: new AbortController().signal,
    storage: createInMemoryStorage(),
    ...overrides,
  };
}

/** 创建最小 CustomNodeDef（用于传给 executor） */
function makeCustomNodeDef(overrides?: Record<string, unknown>) {
  return {
    type: "custom" as const,
    id: "n1",
    tool: "echo_tool",
    outputs: { out: { pattern: "/tmp/x", type: "file" as const } },
    ...overrides,
  };
}

// 正常执行: execute 返回 NodeOutput
test("正常执行返回 NodeOutput", async () => {
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "echo_tool",
    description: "echo",
    inputs: {},
    produces: ["out"],
    execute: async () => ({ stdout: "hello", exit_code: 0 }),
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  const result = await executor.execute(makeCustomNodeDef(), createTestCtx());
  expect(result.stdout).toBe("hello");
  expect(result.exit_code).toBe(0);
});

// tool 未注册时抛 WorkflowError
test("tool 未注册时抛 WorkflowError", async () => {
  const registry = new CustomNodeRegistry();
  const executor = new CustomNodeExecutor(registry);
  await expect(executor.execute(makeCustomNodeDef({ tool: "nonexistent" }), createTestCtx())).rejects.toThrow(
    WorkflowError,
  );
});

// execute 失败后 onCleanup 仍被调用
test("execute 失败后 onCleanup 仍被调用", async () => {
  let cleanupCalled = false;
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "failing_tool",
    description: "fails",
    inputs: {},
    produces: [],
    execute: async () => {
      throw new Error("boom");
    },
    onCleanup: async () => {
      cleanupCalled = true;
    },
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  await expect(executor.execute(makeCustomNodeDef({ tool: "failing_tool" }), createTestCtx())).rejects.toThrow("boom");
  expect(cleanupCalled).toBe(true);
});

// execute 成功时 onCleanup 也被调用
test("execute 成功时 onCleanup 也被调用", async () => {
  let cleanupCalled = false;
  let cleanupResult: NodeOutput | null = null;
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "clean_tool",
    description: "clean",
    inputs: {},
    produces: [],
    execute: async () => ({ stdout: "ok", exit_code: 0 }),
    onCleanup: async (_ctx, result) => {
      cleanupCalled = true;
      cleanupResult = result;
    },
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  const result = await executor.execute(makeCustomNodeDef({ tool: "clean_tool" }), createTestCtx());
  expect(cleanupCalled).toBe(true);
  expect(cleanupResult?.stdout).toBe("ok");
});

// Zod 校验失败时抛 WorkflowError
test("Zod 校验失败时抛 WorkflowError", async () => {
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "validated_tool",
    description: "validated",
    inputs: {
      age: { type: "number", required: true, description: "Age", validate: z.number().min(18) },
    },
    produces: [],
    execute: async () => ({ stdout: "ok", exit_code: 0 }),
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  // 模拟调度器已解析 inputs（resolveInputs 返回格式）
  const resolvedInputs = {
    inputs: { age: { value: 15, rawExpression: "15" } },
  };
  await expect(
    executor.execute(makeCustomNodeDef({ tool: "validated_tool" }), createTestCtx({ resolvedInputs })),
  ).rejects.toThrow(WorkflowError);
});

// onCleanup 抛异常不影响 execute 结果
test("onCleanup 抛异常不影响 execute 结果", async () => {
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "cleanup_fail_tool",
    description: "cleanup fails",
    inputs: {},
    produces: [],
    execute: async () => ({ stdout: "ok", exit_code: 0 }),
    onCleanup: async () => {
      throw new Error("cleanup boom");
    },
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  // onCleanup 异常应该被 console.error 记录但不重抛
  const result = await executor.execute(makeCustomNodeDef({ tool: "cleanup_fail_tool" }), createTestCtx());
  expect(result.stdout).toBe("ok");
});

// 带 inputs 的工具，从 resolvedInputs 正确提取值
test("从 resolvedInputs 提取 inputs 值并传递给 execute", async () => {
  let receivedInputs: Record<string, unknown> = {};
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "input_tool",
    description: "captures inputs",
    inputs: {
      name: { type: "string", required: true, description: "Name" },
    },
    produces: [],
    execute: async (ctx) => {
      receivedInputs = { ...ctx.inputs };
      return { stdout: JSON.stringify(ctx.inputs), exit_code: 0 };
    },
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  const resolvedInputs = {
    inputs: { name: { value: "Alice", rawExpression: '"Alice"' } },
  };
  const result = await executor.execute(makeCustomNodeDef({ tool: "input_tool" }), createTestCtx({ resolvedInputs }));
  expect(receivedInputs.name).toBe("Alice");
  expect(result.stdout).toContain("Alice");
});
