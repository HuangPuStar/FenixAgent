/**
 * TransformExecutor 测试
 */

import { describe, expect, test } from "bun:test";
import { TransformExecutor } from "../../executor/transform-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { TransformNodeDef } from "../../types/dag";
import { WorkflowError } from "../../types/errors";

// ---------- 辅助工具 ----------

/** 创建测试用的 NodeExecutionContext */
function makeCtx(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const storage = createInMemoryStorage();
  return {
    runId: "test-run-001",
    params: { minScore: 80 },
    secrets: { API_KEY: "test-key-123", PREFIX: "USER_" },
    resolvedInputs: {},
    signal: AbortSignal.timeout(30_000),
    storage,
    ...overrides,
  };
}

/** 创建 transform 节点定义 */
function transformNode(output: Record<string, string>, overrides?: Partial<TransformNodeDef>): TransformNodeDef {
  return {
    id: "tf-test",
    type: "transform",
    output,
    ...overrides,
  };
}

// ========== TransformExecutor 测试 ==========

describe("TransformExecutor", () => {
  // 创建 executor 实例
  test("创建 TransformExecutor 实例", () => {
    const executor = new TransformExecutor();
    expect(executor).toBeDefined();
  });

  // 基本字段映射
  test("基本字段映射 — 从 inputs 提取字段", async () => {
    const executor = new TransformExecutor();
    const ctx = makeCtx({
      resolvedInputs: {
        inputs: {
          data: {
            value: {
              items: [
                { name: "Alice", score: 95 },
                { name: "Bob", score: 87 },
              ],
              total: 2,
            },
            rawExpression: "nodes.api_1.output",
          },
        },
      },
    });
    const node = transformNode({
      names: "data.items.map(i => i.name)",
      count: "data.total",
    });

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.json).toEqual({ names: ["Alice", "Bob"], count: 2 });
    expect(output.stdout).toContain('"Alice"');
  });

  // 表达式访问 params
  test("表达式可访问 params", async () => {
    const executor = new TransformExecutor();
    const ctx = makeCtx({
      params: { minScore: 80 },
      resolvedInputs: {
        inputs: {
          data: {
            value: {
              items: [
                { name: "Alice", score: 95 },
                { name: "Bob", score: 60 },
              ],
            },
            rawExpression: "nodes.api_1.output",
          },
        },
      },
    });
    const node = transformNode({
      passing: "data.items.filter(i => i.score >= params.minScore).map(i => i.name)",
    });

    const output = await executor.execute(node, ctx);

    expect(output.json).toEqual({ passing: ["Alice"] });
  });

  // 表达式访问 secrets
  test("表达式可访问 secrets", async () => {
    const executor = new TransformExecutor();
    const ctx = makeCtx({
      secrets: { PREFIX: "USER_" },
      resolvedInputs: {
        inputs: {
          data: { value: { name: "Alice" }, rawExpression: "nodes.api_1.output" },
        },
      },
    });
    const node = transformNode({
      prefixed: "secrets.PREFIX + data.name",
    });

    const output = await executor.execute(node, ctx);

    expect(output.json).toEqual({ prefixed: "USER_Alice" });
  });

  // 简单计算
  test("简单计算 — reduce 求平均值", async () => {
    const executor = new TransformExecutor();
    const ctx = makeCtx({
      resolvedInputs: {
        inputs: {
          data: {
            value: { items: [{ score: 10 }, { score: 20 }, { score: 30 }] },
            rawExpression: "nodes.api_1.output",
          },
        },
      },
    });
    const node = transformNode({
      avg: "(data.items.reduce((s, i) => s + i.score, 0) / data.items.length).toFixed(1)",
    });

    const output = await executor.execute(node, ctx);

    expect(output.json).toEqual({ avg: "20.0" });
  });

  // 表达式失败 → 整节点失败
  test("表达式抛异常 → 整节点抛出 WorkflowError", async () => {
    const executor = new TransformExecutor();
    const ctx = makeCtx({
      resolvedInputs: {
        inputs: {
          data: { value: null, rawExpression: "nodes.api_1.output" },
        },
      },
    });
    const node = transformNode({
      result: "data.items.length",
    });

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // 非 transform 节点类型 → 报错
  test("传入非 transform 节点类型 → 抛错", async () => {
    const executor = new TransformExecutor();
    const ctx = makeCtx();
    const node = { id: "test", type: "shell", command: "echo" } as unknown as TransformNodeDef;

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // 无 inputs 节点（仅使用 params）
  test("无 inputs 字段 — 仅使用 params", async () => {
    const executor = new TransformExecutor();
    const ctx = makeCtx({
      params: { env: "production", threshold: 100 },
    });
    const node = transformNode({
      config: "JSON.stringify({ env: params.env, threshold: params.threshold })",
    });

    const output = await executor.execute(node, ctx);

    const parsed = JSON.parse(output.stdout);
    expect(parsed.config).toBe('{"env":"production","threshold":100}');
  });
});
