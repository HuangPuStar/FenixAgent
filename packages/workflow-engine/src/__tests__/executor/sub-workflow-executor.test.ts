/**
 * SubWorkflowExecutor 测试
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeExecutorRegistry, type NodeExecutorRegistry } from "../../executor/node-executor";
import { ProcessExecutor } from "../../executor/process-executor";
import { SubWorkflowExecutor } from "../../executor/sub-workflow-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { NodeDef, SubWorkflowNodeDef } from "../../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";

// ---------- 辅助工具 ----------

/** 创建测试用的 NodeExecutionContext */
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

/** 创建子流程节点定义 */
function subWorkflowNode(ref: string, overrides?: Partial<SubWorkflowNodeDef>): SubWorkflowNodeDef {
  return {
    id: "sub-wf-node",
    type: "workflow",
    ref,
    ...overrides,
  };
}

/** 创建带 shell 执行器的注册表 */
function makeRegistry(): NodeExecutorRegistry {
  const registry = createNodeExecutorRegistry();
  registry.register("shell", new ProcessExecutor());
  registry.register("workflow", new SubWorkflowExecutor("test-run-001", registry));
  return registry;
}

/** 简单子工作流 YAML — echo hello */
const SIMPLE_SUB_WORKFLOW_YAML = `\
schema_version: "1"
name: simple-sub
nodes:
  - id: step1
    type: shell
    command: echo "hello from sub"
`;

/** 失败的子工作流 YAML — exit 1 */
const FAILING_SUB_WORKFLOW_YAML = `\
schema_version: "1"
name: failing-sub
nodes:
  - id: fail-step
    type: shell
    command: exit 1
`;

/** 两步子工作流 YAML */
const TWO_STEP_SUB_WORKFLOW_YAML = `\
schema_version: "1"
name: two-step-sub
nodes:
  - id: step1
    type: shell
    command: echo "first"
  - id: step2
    type: shell
    command: echo "second"
    depends_on: [step1]
`;

/** 嵌套子工作流 — 引用另一个子工作流 */
const NESTED_SUB_WORKFLOW_YAML = `\
schema_version: "1"
name: nested-sub
nodes:
  - id: inner-step
    type: shell
    command: echo "inner hello"
`;

/** 引用嵌套子工作流的父级 YAML */
const NESTED_PARENT_YAML = `\
schema_version: "1"
name: nested-parent
nodes:
  - id: sub-ref
    type: workflow
    ref: nested-sub.yaml
`;

// ========== SubWorkflowExecutor 测试 ==========

describe("SubWorkflowExecutor", () => {
  let tmpDir: string;
  let registry: NodeExecutorRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wf-test-"));
    registry = makeRegistry();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 基本子流程执行 → 正确输出
  test("基本子流程执行返回正确输出", async () => {
    const subYamlPath = join(tmpDir, "simple.yaml");
    writeFileSync(subYamlPath, SIMPLE_SUB_WORKFLOW_YAML);

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("simple.yaml");

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toContain("hello from sub");
  });

  // sub_workflow.started 事件
  test("发射 sub_workflow.started 事件", async () => {
    const subYamlPath = join(tmpDir, "simple.yaml");
    writeFileSync(subYamlPath, SIMPLE_SUB_WORKFLOW_YAML);

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("simple.yaml");

    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId);
    const startedEvents = events.filter((e) => e.type === "sub_workflow.started");
    expect(startedEvents.length).toBe(1);
    expect(startedEvents[0].metadata?.sub_run_id).toBeTruthy();
    expect(startedEvents[0].node_id).toBe("sub-wf-node");
  });

  // sub_workflow.completed 事件
  test("成功时发射 sub_workflow.completed 事件", async () => {
    const subYamlPath = join(tmpDir, "simple.yaml");
    writeFileSync(subYamlPath, SIMPLE_SUB_WORKFLOW_YAML);

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("simple.yaml");

    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId);
    const completedEvents = events.filter((e) => e.type === "sub_workflow.completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].metadata?.sub_run_id).toBeTruthy();
  });

  // 子流程失败 → 父节点 FAILED + 错误传播
  test("子流程失败时抛出 WorkflowError", async () => {
    const subYamlPath = join(tmpDir, "failing.yaml");
    writeFileSync(subYamlPath, FAILING_SUB_WORKFLOW_YAML);

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("failing.yaml");

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
    await expect(executor.execute(node, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.SUB_WORKFLOW_ERROR,
    });
  });

  // 子流程失败事件包含 status: FAILED
  test("子流程失败时 completed 事件包含 status FAILED", async () => {
    const subYamlPath = join(tmpDir, "failing.yaml");
    writeFileSync(subYamlPath, FAILING_SUB_WORKFLOW_YAML);

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("failing.yaml");

    try {
      await executor.execute(node, ctx);
    } catch {}

    const events = await ctx.storage.getEvents(ctx.runId);
    const completedEvents = events.filter((e) => e.type === "sub_workflow.completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].metadata?.status).toBe("FAILED");
  });

  // ignore_errors: true → 父节点 COMPLETED
  test("ignore_errors: true 时子流程失败不传播", async () => {
    const subYamlPath = join(tmpDir, "failing.yaml");
    writeFileSync(subYamlPath, FAILING_SUB_WORKFLOW_YAML);

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("failing.yaml", { ignore_errors: true });

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.json).toEqual({ _sub_workflow_failed: true, _sub_run_id: expect.any(String) });
  });

  // ignore_errors 时 completed 事件包含 ignore_errors 标记
  test("ignore_errors: true 时 completed 事件包含 ignore_errors 标记", async () => {
    const subYamlPath = join(tmpDir, "failing.yaml");
    writeFileSync(subYamlPath, FAILING_SUB_WORKFLOW_YAML);

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("failing.yaml", { ignore_errors: true });

    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId);
    const completedEvents = events.filter((e) => e.type === "sub_workflow.completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].metadata?.ignore_errors).toBe(true);
    expect(completedEvents[0].metadata?.status).toBe("FAILED");
  });

  // 子工作流文件不存在 → 报错
  test("子工作流文件不存在时抛出 WorkflowError", async () => {
    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("nonexistent.yaml");

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
    await expect(executor.execute(node, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.SUB_WORKFLOW_ERROR,
    });
  });

  // 子工作流 YAML 无效 → 报错
  test("无效 YAML 抛出 WorkflowError", async () => {
    const subYamlPath = join(tmpDir, "invalid.yaml");
    writeFileSync(subYamlPath, "not: valid: yaml: structure: [");

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("invalid.yaml");

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // 两步子工作流返回最后一个节点的输出
  test("两步子工作流返回最后节点输出", async () => {
    const subYamlPath = join(tmpDir, "two-step.yaml");
    writeFileSync(subYamlPath, TWO_STEP_SUB_WORKFLOW_YAML);

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("two-step.yaml");

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toContain("second");
  });

  // 非 workflow 节点 → 报错
  test("非 workflow 节点类型抛出 WorkflowError", async () => {
    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = { id: "bad", type: "shell", command: "echo hi" } as NodeDef;

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
    await expect(executor.execute(node, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
    });
  });

  // 嵌套 2 层子工作流
  test("嵌套 2 层子工作流正确执行", async () => {
    const nestedDir = join(tmpDir, "nested");
    mkdirSync(nestedDir, { recursive: true });

    // 写入内层子工作流
    writeFileSync(join(nestedDir, "nested-sub.yaml"), NESTED_SUB_WORKFLOW_YAML);
    // 写入外层子工作流（引用内层）
    writeFileSync(join(nestedDir, "nested-parent.yaml"), NESTED_PARENT_YAML);
    // 写入最外层子工作流（引用外层）
    const outerYaml = `\
schema_version: "1"
name: outer-sub
nodes:
  - id: call-nested
    type: workflow
    ref: nested-parent.yaml
`;
    writeFileSync(join(nestedDir, "outer.yaml"), outerYaml);

    // 创建嵌套注册表：需要递归注册 SubWorkflowExecutor
    // 外层 executor 的 baseDir 是 nestedDir
    const outerExecutor = new SubWorkflowExecutor("parent-run", registry, nestedDir);
    registry.register("workflow", outerExecutor);

    const ctx = makeCtx();
    const node = subWorkflowNode("outer.yaml");

    const output = await outerExecutor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toContain("inner hello");
  });

  // 父级取消传播到子工作流
  test("父级取消时子工作流被取消", async () => {
    const subYamlPath = join(tmpDir, "slow.yaml");
    // 创建一个会运行较长时间的子工作流
    writeFileSync(
      subYamlPath,
      `\
schema_version: "1"
name: slow-sub
nodes:
  - id: slow-step
    type: shell
    command: sleep 10
`,
    );

    const abortController = new AbortController();
    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx({
      signal: abortController.signal,
    });
    const node = subWorkflowNode("slow.yaml");

    // 启动执行后立即取消
    const executePromise = executor.execute(node, ctx);
    // 给一点时间让子工作流启动
    await new Promise((resolve) => setTimeout(resolve, 100));
    abortController.abort();

    await expect(executePromise).rejects.toThrow(WorkflowError);
  });

  // 参数传递
  test("参数传递到子工作流", async () => {
    const subYamlPath = join(tmpDir, "param-sub.yaml");
    writeFileSync(
      subYamlPath,
      `\
schema_version: "1"
name: param-sub
params:
  message:
    type: string
    default: "default-msg"
nodes:
  - id: echo-param
    type: shell
    inputs:
      MSG: params.message
    command: 'printf "%s" "$MSG"'
`,
    );

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx({
      resolvedInputs: {
        ref: "param-sub.yaml",
        params: { message: "hello-param" },
      },
    });
    const node = subWorkflowNode("param-sub.yaml", {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test input for expression parser
      params: { message: "${{ params.message }}" },
    });

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toContain("hello-param");
  });

  // 子工作流的事件存储在同一个 storage 中
  test("子工作流事件存储在父级 storage 中", async () => {
    const subYamlPath = join(tmpDir, "simple.yaml");
    writeFileSync(subYamlPath, SIMPLE_SUB_WORKFLOW_YAML);

    const executor = new SubWorkflowExecutor("parent-run", registry, tmpDir);
    const ctx = makeCtx();
    const node = subWorkflowNode("simple.yaml");

    await executor.execute(node, ctx);

    // 检查父级 run 的事件
    const parentEvents = await ctx.storage.getEvents(ctx.runId);
    const subStarted = parentEvents.find((e) => e.type === "sub_workflow.started");
    expect(subStarted).toBeTruthy();

    // 检查子工作流 run 的事件也存在
    const subRunId = subStarted!.metadata!.sub_run_id as string;
    const subEvents = await ctx.storage.getEvents(subRunId);
    expect(subEvents.length).toBeGreaterThan(0);

    const dagStarted = subEvents.find((e) => e.type === "dag.started");
    expect(dagStarted).toBeTruthy();
  });
});
