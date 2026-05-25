/**
 * LoopExecutor 测试
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { LoopExecutor } from "../../executor/loop-executor";
import { createNodeExecutorRegistry, type NodeExecutorRegistry } from "../../executor/node-executor";
import type { NodeExecutionContext, NodeExecutor } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { LoopNodeDef, NodeDef } from "../../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";
import type { NodeOutput } from "../../types/execution";

// ---------- 辅助工具 ----------

/** 创建测试用的 NodeExecutionContext */
function makeCtx(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const storage = createInMemoryStorage();
  return {
    runId: "test-loop-run-001",
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: AbortSignal.timeout(30_000),
    storage,
    ...overrides,
  };
}

/** 创建循环节点定义 */
function loopNode(overrides?: Partial<LoopNodeDef>): LoopNodeDef {
  return {
    id: "my-loop",
    type: "loop",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test input for expression parser
    condition: '${{ nodes.step1.output.value != "done" }}',
    max_iterations: 10,
    body: {
      nodes: [
        {
          id: "step1",
          type: "shell",
          command: "echo done",
        },
      ],
    },
    ...overrides,
  };
}

/**
 * 创建一个 mock NodeExecutor，根据调用次数返回不同的输出。
 * bodyNodes 用于匹配节点 ID 前缀。
 */
function createMockExecutor(outputFn: (nodeId: string, callCount: number) => NodeOutput): NodeExecutor {
  const callCounts = new Map<string, number>();
  return {
    async execute(node: NodeDef, _ctx: NodeExecutionContext): Promise<NodeOutput> {
      const count = (callCounts.get(node.id) ?? 0) + 1;
      callCounts.set(node.id, count);
      return outputFn(node.id, count);
    },
  };
}

// ========== 基本循环测试 ==========

describe("LoopExecutor", () => {
  let registry: NodeExecutorRegistry;

  beforeEach(() => {
    registry = createNodeExecutorRegistry();
  });

  // 基本循环：3 次迭代后 condition 为 false → 退出
  test("基本循环：迭代直到条件为 false 后退出", async () => {
    let callCount = 0;
    const mockExecutor = createMockExecutor((_nodeId, _count) => {
      callCount++;
      // 前 2 次返回 value != "done"，第 3 次返回 "done"
      if (callCount <= 2) {
        return {
          stdout: JSON.stringify({ value: "not-done" }),
          json: { value: "not-done" },
          exit_code: 0,
        };
      }
      return {
        stdout: JSON.stringify({ value: "done" }),
        json: { value: "done" },
        exit_code: 0,
      };
    });

    registry.register("shell", mockExecutor);
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx();
    const node = loopNode({ max_iterations: 10 });

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(callCount).toBe(3); // 执行了 3 次迭代

    // 验证 loop 事件
    const events = await ctx.storage.getEvents(ctx.runId);
    const startedEvents = events.filter((e) => e.type === "loop.iteration_started");
    const completedEvents = events.filter((e) => e.type === "loop.iteration_completed");

    expect(startedEvents).toHaveLength(3);
    expect(completedEvents).toHaveLength(3);

    // 最后一次 completed 的 will_continue 应为 false
    expect(completedEvents[2].metadata?.will_continue).toBe(false);
    // 前两次的 will_continue 应为 true
    expect(completedEvents[0].metadata?.will_continue).toBe(true);
    expect(completedEvents[1].metadata?.will_continue).toBe(true);
  });

  // max_iterations 达到 → 强制退出 + FAILED
  test("max_iterations 达到上限时抛出 LOOP_MAX_ITERATIONS", async () => {
    const mockExecutor = createMockExecutor(() => ({
      stdout: JSON.stringify({ value: "never-done" }),
      json: { value: "never-done" },
      exit_code: 0,
    }));

    registry.register("shell", mockExecutor);
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx();
    const node = loopNode({ max_iterations: 3 });

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
    await expect(executor.execute(node, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.LOOP_MAX_ITERATIONS,
    });
  });

  // 迭代中节点失败 → 循环节点 FAILED
  test("子 DAG 节点失败时循环节点抛出 NODE_FAILED", async () => {
    const mockExecutor: NodeExecutor = {
      async execute(_node: NodeDef, _ctx: NodeExecutionContext): Promise<NodeOutput> {
        throw new WorkflowError("step failed", WorkflowErrorCode.NODE_FAILED);
      },
    };

    registry.register("shell", mockExecutor);
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx();
    const node = loopNode({ max_iterations: 5 });

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
    await expect(executor.execute(node, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
    });
  });

  // 条件引用子 DAG 内节点输出
  test("条件正确引用子 DAG 节点输出", async () => {
    let callCount = 0;
    const mockExecutor = createMockExecutor(() => {
      callCount++;
      const counter = callCount;
      return {
        stdout: JSON.stringify({ counter }),
        json: { counter },
        exit_code: 0,
      };
    });

    registry.register("shell", mockExecutor);
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx();

    // 条件：counter >= 5 时退出
    const node = loopNode({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test input for expression parser
      condition: "${{ nodes.step1.output.counter < 5 }}",
      max_iterations: 20,
    });

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(callCount).toBe(5); // counter=1,2,3,4 继续循环，counter=5 时条件 false 退出
  });

  // loop 事件正确发射
  test("loop 事件包含正确的 metadata", async () => {
    const mockExecutor = createMockExecutor(() => ({
      stdout: JSON.stringify({ value: "done" }),
      json: { value: "done" },
      exit_code: 0,
    }));

    registry.register("shell", mockExecutor);
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx();
    const node = loopNode({ max_iterations: 5 });

    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId);

    // iteration_started 事件
    const startedEvents = events.filter((e) => e.type === "loop.iteration_started");
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].node_id).toBe("my-loop");
    expect(startedEvents[0].node_type).toBe("loop");
    expect(startedEvents[0].metadata?.iteration).toBe(0);
    expect(startedEvents[0].metadata?.max_iterations).toBe(5);

    // iteration_completed 事件
    const completedEvents = events.filter((e) => e.type === "loop.iteration_completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].metadata?.iteration).toBe(0);
    expect(completedEvents[0].metadata?.will_continue).toBe(false);
  });

  // 取消信号传播
  test("父级 AbortSignal 中止时循环取消", async () => {
    const abortController = new AbortController();
    let callCount = 0;

    const mockExecutor: NodeExecutor = {
      async execute(_node: NodeDef, _ctx: NodeExecutionContext): Promise<NodeOutput> {
        callCount++;
        // 第一次调用后中止
        if (callCount === 1) {
          abortController.abort();
        }
        return {
          stdout: JSON.stringify({ value: "not-done" }),
          json: { value: "not-done" },
          exit_code: 0,
        };
      },
    };

    registry.register("shell", mockExecutor);
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx({ signal: abortController.signal });
    const node = loopNode({ max_iterations: 100 });

    // 应该抛出 DAG_CANCELLED（因为取消发生在第二次迭代开始前的检查）
    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // 非循环节点类型时抛出错误
  test("非 loop 类型节点抛出 NODE_FAILED", async () => {
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx();
    const shellNode: NodeDef = {
      id: "not-a-loop",
      type: "shell",
      command: "echo hello",
    };

    await expect(executor.execute(shellNode, ctx)).rejects.toThrow(WorkflowError);
    await expect(executor.execute(shellNode, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
    });
  });

  // 多节点子 DAG 测试
  test("多节点子 DAG 正确执行", async () => {
    let step2CallCount = 0;
    const callLog: string[] = [];

    const mockExecutor: NodeExecutor = {
      async execute(node: NodeDef, _ctx: NodeExecutionContext): Promise<NodeOutput> {
        callLog.push(node.id);
        // step1 总是返回 counter=1，step2 根据 counter 决定
        if (node.id.includes("step1")) {
          return {
            stdout: JSON.stringify({ counter: 1 }),
            json: { counter: 1 },
            exit_code: 0,
          };
        }
        // step2
        step2CallCount++;
        return {
          stdout: JSON.stringify({ result: step2CallCount >= 3 ? "done" : "running" }),
          json: { result: step2CallCount >= 3 ? "done" : "running" },
          exit_code: 0,
        };
      },
    };

    registry.register("shell", mockExecutor);
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx();

    const node: LoopNodeDef = {
      id: "multi-loop",
      type: "loop",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test input for expression parser
      condition: '${{ nodes.step2.output.result != "done" }}',
      max_iterations: 10,
      body: {
        nodes: [
          { id: "step1", type: "shell", command: "echo 1", depends_on: [] },
          { id: "step2", type: "shell", command: "echo 2", depends_on: ["step1"] },
        ],
      },
    };

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(step2CallCount).toBe(3); // 3 次迭代后 step2 返回 'done'

    // 验证最后一次迭代的输出
    expect(output.json).toEqual({ result: "done" });
  });

  // 输出为最后一次迭代的最后一个节点
  test("循环节点输出为最后一次迭代的最终节点输出", async () => {
    let callCount = 0;
    const mockExecutor = createMockExecutor(() => {
      callCount++;
      return {
        stdout: JSON.stringify({ final: callCount < 3 ? "running" : "result" }),
        json: { final: callCount < 3 ? "running" : "result" },
        exit_code: 0,
      };
    });

    registry.register("shell", mockExecutor);
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx();
    const node = loopNode({
      max_iterations: 10,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test input for expression parser
      condition: '${{ nodes.step1.output.final != "result" }}',
    });

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.json).toEqual({ final: "result" });
  });

  // 条件不带 ${{ }} 包装也能工作
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description with literal expression syntax
  test("条件不带 ${{ }} 包装时正常求值", async () => {
    let callCount = 0;
    const mockExecutor = createMockExecutor(() => {
      callCount++;
      return {
        stdout: JSON.stringify({ value: callCount >= 2 ? "stop" : "go" }),
        json: { value: callCount >= 2 ? "stop" : "go" },
        exit_code: 0,
      };
    });

    registry.register("shell", mockExecutor);
    const executor = new LoopExecutor("test-loop-run-001", registry);
    const ctx = makeCtx();

    // 条件不带 ${{ }} 包装；do-while 语义：true → 继续
    const node = loopNode({
      condition: 'nodes.step1.output.value != "stop"',
      max_iterations: 10,
    });

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(callCount).toBe(2); // iter0: go!=stop→true→继续; iter1: stop!=stop→false→退出
  });
});
