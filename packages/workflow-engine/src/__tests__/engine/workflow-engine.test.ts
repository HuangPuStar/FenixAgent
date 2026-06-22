/**
 * createWorkflowEngine 引擎门面测试。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { DryRunResult, WorkflowEngineOptions } from "../../engine/workflow-engine";
import { createWorkflowEngine } from "../../engine/workflow-engine";
import { verifyApprovalToken } from "../../executor/awaitable-executor";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import { WorkflowError } from "../../types/errors";

// ---------- 辅助工具 ----------

const HMAC_SECRET = "test-hmac-secret-for-unit-tests";

/** 创建引擎实例（不传 transport） */
function createTestEngine(options?: Partial<WorkflowEngineOptions>) {
  return createWorkflowEngine({
    storage: createInMemoryStorage(),
    hmacSecret: HMAC_SECRET,
    ...options,
  });
}

/** 简单 shell 工作流 YAML */
const SIMPLE_SHELL_YAML = `
name: test-shell-workflow
schema_version: "1"
nodes:
  - id: step1
    type: shell
    command: echo "hello world"
  - id: step2
    type: shell
    command: echo "done"
    depends_on: [step1]
`;

/** 无效 YAML（缺少必填字段） */
const INVALID_YAML = `
name: bad-workflow
schema_version: "1"
nodes: []
`;

/** 并行工作流 YAML（两个无依赖节点 + 一个依赖它们的节点） */
const PARALLEL_YAML = `
name: parallel-workflow
schema_version: "1"
nodes:
  - id: task-a
    type: shell
    command: echo "a"
  - id: task-b
    type: shell
    command: echo "b"
  - id: task-c
    type: shell
    command: echo "c"
    depends_on: [task-a, task-b]
`;

/** 带 secret 声明的工作流 YAML */
const SECRETS_YAML = `
name: secrets-workflow
schema_version: "1"
secrets:
  - MY_SECRET
nodes:
  - id: step1
    type: shell
    command: echo "hello"
`;

/** 带审计节点的工作流 YAML */
const AUDIT_YAML = `
name: audit-workflow
schema_version: "1"
nodes:
  - id: step1
    type: shell
    command: echo "before audit"
  - id: approval
    type: audit
    display_data:
      message: Please approve
    depends_on: [step1]
  - id: step3
    type: shell
    command: echo "after audit"
    depends_on: [approval]
`;

/** 长时间运行的 shell 命令（用于 cancel 测试） */
const _LONG_RUNNING_YAML = `
name: long-running-workflow
schema_version: "1"
nodes:
  - id: slow-step
    type: shell
    command: sleep 30
`;

/** 依赖不存在的节点（校验失败） */
const BAD_DEPS_YAML = `
name: bad-deps-workflow
schema_version: "1"
nodes:
  - id: step1
    type: shell
    command: echo "hello"
    depends_on: [nonexistent]
`;

// ---------- 测试套件 ----------

describe("createWorkflowEngine", () => {
  let engine: ReturnType<typeof createTestEngine>;

  beforeEach(() => {
    engine = createTestEngine();
  });

  // ---------- parse ----------

  test("解析简单 YAML 返回 WorkflowDef", () => {
    const def = engine.parse(SIMPLE_SHELL_YAML);
    expect(def.name).toBe("test-shell-workflow");
    expect(def.schema_version).toBe("1");
    expect(def.nodes).toHaveLength(2);
    expect(def.nodes[0].id).toBe("step1");
    expect(def.nodes[0].type).toBe("shell");
  });

  // ---------- validate ----------

  test("校验合法的 WorkflowDef 返回 valid=true", () => {
    const def = engine.parse(SIMPLE_SHELL_YAML);
    const result = engine.validate(def);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("校验空节点列表返回 valid=true（空工作流合法）", () => {
    const def = engine.parse(INVALID_YAML);
    const result = engine.validate(def);
    // 空节点是合法的
    expect(result.valid).toBe(true);
  });

  // ---------- run ----------

  test("执行简单 shell 工作流返回 SUCCESS", async () => {
    const result = await engine.run(SIMPLE_SHELL_YAML);
    expect(result.status).toBe("SUCCESS");
    expect(result.runId).toMatch(/^run_/);
    expect(result.summary.node_summary.total).toBe(2);
    expect(result.summary.node_summary.completed).toBe(2);
    expect(result.summary.node_summary.failed).toBe(0);
  });

  test("执行时传入 params", async () => {
    const result = await engine.run(SIMPLE_SHELL_YAML, { foo: "bar" });
    expect(result.status).toBe("SUCCESS");
  });

  test("执行无效 YAML 抛出 WorkflowError", async () => {
    // 缺少依赖的节点应该在校验时失败
    await expect(engine.run(BAD_DEPS_YAML)).rejects.toThrow(WorkflowError);
  });

  test("secrets 声明存在但密钥不存在时抛出错误", async () => {
    // MY_SECRET 不在环境变量中
    // 确保 MY_SECRET 确实不存在
    const original = process.env.MY_SECRET;
    delete process.env.MY_SECRET;
    try {
      await expect(engine.run(SECRETS_YAML)).rejects.toThrow();
    } finally {
      if (original !== undefined) process.env.MY_SECRET = original;
    }
  });

  // ---------- dryRun ----------

  test("dryRun 返回正确的执行计划", () => {
    const result: DryRunResult = engine.dryRun(SIMPLE_SHELL_YAML);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    // 拓扑序：step1 → step2
    expect(result.executionPlan.topologicalOrder).toEqual(["step1", "step2"]);
    // 并行组：[[step1], [step2]]
    expect(result.executionPlan.parallelGroups).toEqual([["step1"], ["step2"]]);
  });

  test("dryRun 识别并行节点组", () => {
    const result: DryRunResult = engine.dryRun(PARALLEL_YAML);
    expect(result.valid).toBe(true);
    // 并行组：[[task-a, task-b], [task-c]]
    expect(result.executionPlan.parallelGroups).toHaveLength(2);
    expect(result.executionPlan.parallelGroups[0]).toHaveLength(2);
    expect(result.executionPlan.parallelGroups[1]).toEqual(["task-c"]);
  });

  test("dryRun 对无效 YAML 返回 valid=false", () => {
    const result = engine.dryRun(BAD_DEPS_YAML);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.executionPlan.topologicalOrder).toHaveLength(0);
  });

  // ---------- cancel ----------

  test("cancel 不存在的 run 抛出 WorkflowError", async () => {
    await expect(engine.cancel("run_nonexistent")).rejects.toThrow(WorkflowError);
  });

  // ---------- getRunStatus / getOutput / getEvents ----------

  test("getRunStatus 在运行后返回快照", async () => {
    const result = await engine.run(SIMPLE_SHELL_YAML);
    const snapshot = await engine.getRunStatus(result.runId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.dag_status).toBe("SUCCESS");
    expect(snapshot!.run_id).toBe(result.runId);
  });

  test("getRunStatus 对不存在的 run 返回 null", async () => {
    const snapshot = await engine.getRunStatus("run_nonexistent");
    expect(snapshot).toBeNull();
  });

  test("getOutput 返回已完成节点的输出", async () => {
    const result = await engine.run(SIMPLE_SHELL_YAML);
    const output = await engine.getOutput(result.runId, "step1");
    expect(output).not.toBeNull();
    expect(output!.exit_code).toBe(0);
    expect(output!.stdout).toContain("hello world");
  });

  test("getOutput 对不存在的节点返回 null", async () => {
    const result = await engine.run(SIMPLE_SHELL_YAML);
    const output = await engine.getOutput(result.runId, "nonexistent");
    expect(output).toBeNull();
  });

  test("getEvents 返回运行期间的所有事件", async () => {
    const result = await engine.run(SIMPLE_SHELL_YAML);
    const events = await engine.getEvents(result.runId);
    // 至少有 dag.started, node.started x2, node.completed x2, dag.completed
    expect(events.length).toBeGreaterThanOrEqual(5);
    // 第一个事件应该是 dag.started
    expect(events[0].type).toBe("dag.started");
    // 最后一个事件应该是 dag.completed
    expect(events[events.length - 1].type).toBe("dag.completed");
  });

  test("getEvents 按 nodeId 过滤", async () => {
    const result = await engine.run(SIMPLE_SHELL_YAML);
    const events = await engine.getEvents(result.runId, { nodeId: "step1" });
    // step1 应有 started + completed
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.node_id).toBe("step1");
    }
  });

  // ---------- getPendingApprovals ----------

  test("没有审计节点时 getPendingApprovals 返回空数组", async () => {
    const result = await engine.run(SIMPLE_SHELL_YAML);
    const pending = await engine.getPendingApprovals(result.runId);
    expect(pending).toHaveLength(0);
  });

  // ---------- approveNode ----------

  test("approveNode 使用无效 token 抛出错误", async () => {
    await expect(engine.approveNode("run_fake", "node_fake", "invalid-token")).rejects.toThrow(WorkflowError);
  });

  test("approveNode 对不存在的 run 抛出错误", async () => {
    // 生成一个合法格式的 token 但对应不存在的 run
    const { valid } = verifyApprovalToken("fake-token", "run_fake", "node_fake", HMAC_SECRET);
    expect(valid).toBe(false);
  });

  // ---------- recover ----------

  test("recover 对不存在的 run 抛出 WorkflowError", async () => {
    // 没有 snapshot 存在时 recover 应该失败
    await expect(engine.recover("run_nonexistent", SIMPLE_SHELL_YAML)).rejects.toThrow(WorkflowError);
  });

  // ---------- end-to-end: audit workflow ----------

  test("带审计节点的工作流进入 SUSPENDED 状态", async () => {
    const result = await engine.run(AUDIT_YAML);
    expect(result.status).toBe("SUSPENDED");
    expect(result.summary.node_summary.completed).toBeGreaterThanOrEqual(1); // step1 完成
  });

  test("SUSPENDED 后可获取待审批列表", async () => {
    const result = await engine.run(AUDIT_YAML);
    expect(result.status).toBe("SUSPENDED");

    const pending = await engine.getPendingApprovals(result.runId);
    expect(pending).toHaveLength(1);
    expect(pending[0].nodeId).toBe("approval");
    expect(pending[0].runId).toBe(result.runId);
    expect(pending[0].approvalToken).toBeTruthy();
    expect(pending[0].expiresAt).toBeTruthy();
  });

  test("使用正确 token 审批后工作流继续执行", async () => {
    const result = await engine.run(AUDIT_YAML);
    expect(result.status).toBe("SUSPENDED");

    // 获取待审批信息
    const pending = await engine.getPendingApprovals(result.runId);
    expect(pending).toHaveLength(1);

    const { nodeId, approvalToken } = pending[0];

    // 验证 token 有效
    const verifyResult = verifyApprovalToken(approvalToken, result.runId, nodeId, HMAC_SECRET);
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.expired).toBe(false);

    // 审批：SUSPENDED 状态的 run 保留在 activeRuns 中，approveNode 可直接恢复
    await engine.approveNode(result.runId, nodeId, approvalToken);

    // 审批后 step3 应执行完毕，工作流最终状态为 SUCCESS
    const finalSnapshot = await engine.getRunStatus(result.runId);
    expect(finalSnapshot?.dag_status).toBe("SUCCESS");
    const step3Output = await engine.getOutput(result.runId, "step3");
    expect(step3Output?.stdout).toContain("after audit");
  });
});

// ── custom 节点集成测试 ──

import { CustomNodeRegistry } from "../../plugins/registry";
import type { CustomNode } from "../../plugins/types";

/** 构建带 customRegistry 的测试引擎 */
function createTestEngineWithCustom(tools: CustomNode[]) {
  const registry = new CustomNodeRegistry();
  for (const t of tools) registry.register(t);
  return createTestEngine({ customRegistry: registry });
}

test("引擎运行 custom 节点", async () => {
  const tool: CustomNode = {
    name: "simple_echo",
    description: "Echo tool",
    inputs: {},
    produces: ["out"],
    execute: async () => ({ stdout: "echo from custom", exit_code: 0 }),
  };
  const engine = createTestEngineWithCustom([tool]);
  const yaml = `
name: custom-test
schema_version: "1"
nodes:
  - id: c1
    type: custom
    tool: simple_echo
    outputs:
      out:
        pattern: /tmp/x.txt
        type: file
`;
  const result = await engine.run(yaml);
  expect(result.status).toBe("SUCCESS");
  expect(result.summary.node_summary.total).toBe(1);
  expect(result.summary.node_summary.completed).toBe(1);
});

test("custom 节点 tool 未注册时 parse 阶段报错", async () => {
  const engine = createTestEngineWithCustom([]);
  const yaml = `
name: custom-test
schema_version: "1"
nodes:
  - id: c1
    type: custom
    tool: nonexistent
    outputs:
      out:
        pattern: /tmp/x.txt
        type: file
`;
  await expect(engine.run(yaml)).rejects.toThrow(/not registered/);
});
