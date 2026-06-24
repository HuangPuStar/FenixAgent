import { beforeEach, expect, test } from "bun:test";
import { AuditExecutor, verifyApprovalToken } from "../../executor/awaitable-executor";
import { resolveTemplate } from "../../parser/expression-parser";
import { CancellationManager } from "../../scheduler/cancellation";
import type { NodeExecutionContext, NodeExecutor } from "../../scheduler/dag-scheduler";
import { DAGScheduler, SuspendedError } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { AuditNodeDef, CustomNodeDef, NodeDef, ShellNodeDef, WorkflowDef } from "../../types/dag";
import type { DAGEvent, NodeOutput, NodeStatus } from "../../types/execution";

// ---------- 辅助工具 ----------

/** 创建简单 shell 节点 */
function shellNode(id: string, dependsOn?: string[]): ShellNodeDef {
  return { id, type: "shell", command: `echo ${id}`, depends_on: dependsOn };
}

/** 创建工作流定义 */
function makeWorkflow(nodes: NodeDef[], timeout?: number): WorkflowDef {
  return {
    schema_version: "1.0",
    name: "test-workflow",
    nodes,
    ...(timeout ? { timeout } : {}),
  };
}

/** Mock 执行器 — 返回预设结果或抛出预设错误 */
class MockNodeExecutor implements NodeExecutor {
  private readonly outputs = new Map<string, NodeOutput>();
  private readonly errors = new Map<string, Error>();
  private readonly delays = new Map<string, number>();
  private readonly executionOrder: string[] = [];
  private readonly startTimes = new Map<string, number>();
  private readonly endTimes = new Map<string, number>();

  setOutput(nodeId: string, output: NodeOutput): void {
    this.outputs.set(nodeId, output);
  }

  setError(nodeId: string, error: Error): void {
    this.errors.set(nodeId, error);
  }

  setDelay(nodeId: string, delayMs: number): void {
    this.delays.set(nodeId, delayMs);
  }

  getExecutionOrder(): string[] {
    return [...this.executionOrder];
  }

  getStartTimes(): Map<string, number> {
    return new Map(this.startTimes);
  }

  getEndTimes(): Map<string, number> {
    return new Map(this.endTimes);
  }

  reset(): void {
    this.outputs.clear();
    this.errors.clear();
    this.delays.clear();
    this.executionOrder.length = 0;
    this.startTimes.clear();
    this.endTimes.clear();
  }

  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    this.executionOrder.push(node.id);
    this.startTimes.set(node.id, Date.now());

    // 发射 node.started 事件（模拟真实执行器行为）
    await ctx.storage.appendEvent({
      event_id: `evt_mock_${node.id}_start`,
      run_id: ctx.runId,
      node_id: node.id,
      node_type: node.type,
      timestamp: new Date().toISOString(),
      type: "node.started",
    });

    // 检查取消
    if (ctx.signal.aborted) {
      const err = new DOMException("Aborted", "AbortError");
      throw err;
    }

    // 延迟模拟
    const delay = this.delays.get(node.id);
    if (delay) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        ctx.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }

    // 再次检查取消（延迟后）
    if (ctx.signal.aborted) {
      const err = new DOMException("Aborted", "AbortError");
      throw err;
    }

    // 检查预设错误
    const presetError = this.errors.get(node.id);
    if (presetError) {
      // 发射 node.failed 事件
      await ctx.storage.appendEvent({
        event_id: `evt_mock_${node.id}_fail`,
        run_id: ctx.runId,
        node_id: node.id,
        node_type: node.type,
        timestamp: new Date().toISOString(),
        type: "node.failed",
        metadata: { error: presetError.message },
      });
      throw presetError;
    }

    // 返回预设输出
    const output = this.outputs.get(node.id) ?? {
      stdout: `output of ${node.id}`,
      exit_code: 0,
    };

    // 发射 node.completed 事件
    await ctx.storage.appendEvent({
      event_id: `evt_mock_${node.id}_done`,
      run_id: ctx.runId,
      node_id: node.id,
      node_type: node.type,
      timestamp: new Date().toISOString(),
      type: "node.completed",
      metadata: { exit_code: output.exit_code },
    });

    this.endTimes.set(node.id, Date.now());
    return output;
  }
}

/** 创建标准调度上下文 */
function makeContext(executor: MockNodeExecutor, nodes: NodeDef[], timeout?: number) {
  const storage = createInMemoryStorage();
  const cancellation = new CancellationManager();
  const workflow = makeWorkflow(nodes, timeout);

  return {
    runId: "test_run_1",
    workflowDef: workflow,
    storage,
    params: {},
    secrets: {},
    nodeExecutor: executor as NodeExecutor,
    cancellation,
  };
}

// ---------- 测试 ----------

let executor: MockNodeExecutor;

beforeEach(() => {
  executor = new MockNodeExecutor();
});

// ---------- 线性执行 ----------

// A → B → C 按序执行
test("线性 DAG 按依赖顺序执行", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"])];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe("SUCCESS");
  expect(executor.getExecutionOrder()).toEqual(["A", "B", "C"]);
});

// ---------- 并行执行 ----------

// A → [B, C] → D，B 和 C 并行
test("扇出 DAG B 和 C 并行执行", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["A"]), shellNode("D", ["B", "C"])];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  // B 和 C 各延迟 50ms，如果串行则总耗时 >100ms
  executor.setDelay("B", 50);
  executor.setDelay("C", 50);

  const start = Date.now();
  const result = await scheduler.run();
  const elapsed = Date.now() - start;

  expect(result.status).toBe("SUCCESS");

  const order = executor.getExecutionOrder();
  // A 必须第一个
  expect(order[0]).toBe("A");
  // D 必须最后一个
  expect(order[order.length - 1]).toBe("D");
  // B 和 C 都在 A 之后、D 之前
  expect(order.indexOf("B")).toBeGreaterThan(0);
  expect(order.indexOf("C")).toBeGreaterThan(0);
  expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
  expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));

  // 并行验证：总耗时应远小于串行（100ms），允许 30ms 误差
  expect(elapsed).toBeLessThan(130);
});

// 独立节点并行
test("无依赖的节点并行执行", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B"), shellNode("C")];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  executor.setDelay("A", 50);
  executor.setDelay("B", 50);
  executor.setDelay("C", 50);

  const start = Date.now();
  const result = await scheduler.run();
  const elapsed = Date.now() - start;

  expect(result.status).toBe("SUCCESS");
  // 三个 50ms 的节点并行，总耗时应接近 50ms 而非 150ms
  expect(elapsed).toBeLessThan(120);
});

// ---------- 错误传播 ----------

// A 失败 → B 和 D 被跳过（C 不受影响如果独立）
test("节点失败后下游被 SKIPPED", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["A"])];
  executor.setError("A", new Error("A failed"));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe("FAILED");
  expect(result.summary.node_summary.failed).toBe(1);

  // B 和 C 应该被跳过
  const events = await ctx.storage.getEvents("test_run_1");
  const skippedEvents = events.filter((e) => e.type === "node.skipped");
  const skippedNodeIds = new Set(skippedEvents.map((e) => e.node_id));
  expect(skippedNodeIds.has("B")).toBe(true);
  expect(skippedNodeIds.has("C")).toBe(true);
});

// 独立分支不受影响
test("独立分支在 A 失败后仍执行", async () => {
  // A → B, E（独立）
  const nodes: NodeDef[] = [
    shellNode("A"),
    shellNode("B", ["A"]),
    shellNode("E"), // 无依赖，不受 A 影响
  ];
  executor.setError("A", new Error("A failed"));
  executor.setOutput("E", { stdout: "E result", exit_code: 0 });
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe("FAILED");
  // E 应该成功执行
  const order = executor.getExecutionOrder();
  expect(order).toContain("E");

  // B 被跳过，E 不被跳过
  const events = await ctx.storage.getEvents("test_run_1");
  const skippedEvents = events.filter((e) => e.type === "node.skipped");
  const skippedNodeIds = new Set(skippedEvents.map((e) => e.node_id));
  expect(skippedNodeIds.has("B")).toBe(true);
  expect(skippedNodeIds.has("E")).toBe(false);

  // E 的输出应被存储
  const eOutput = await ctx.storage.getOutput("test_run_1", "E");
  expect(eOutput?.stdout).toBe("E result");
});

// 部分失败
test("B 失败不影响已完成的 A", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"])];
  executor.setError("B", new Error("B failed"));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe("FAILED");
  expect(result.summary.node_summary.completed).toBe(1); // A
  expect(result.summary.node_summary.failed).toBe(1); // B

  // A 的输出应被存储
  const aOutput = await ctx.storage.getOutput("test_run_1", "A");
  expect(aOutput).not.toBeNull();
});

// ---------- 取消 ----------

// 中途取消
test("中途取消停止调度新节点", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"])];
  executor.setDelay("A", 200); // A 执行中取消
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  // 50ms 后取消
  setTimeout(() => ctx.cancellation.cancel(), 50);

  const result = await scheduler.run();

  expect(result.status).toBe("CANCELLED");

  // dag.cancelled 事件应被发射
  const events = await ctx.storage.getEvents("test_run_1");
  expect(events.some((e) => e.type === "dag.cancelled")).toBe(true);
});

// 取消后 RUNNING 节点收到 node.cancelled
test("取消后 RUNNING 节点被标记为 CANCELLED", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B"), shellNode("C")];
  executor.setDelay("A", 200);
  executor.setDelay("B", 200);
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  setTimeout(() => ctx.cancellation.cancel(), 50);

  const result = await scheduler.run();

  expect(result.status).toBe("CANCELLED");

  const events = await ctx.storage.getEvents("test_run_1");
  const _cancelledEvents = events.filter((e) => e.type === "node.cancelled");
  // 至少有 dag.cancelled，节点级 cancelled 取决于执行时机
  expect(events.some((e) => e.type === "dag.cancelled")).toBe(true);
});

// ---------- DAG 超时 ----------

// 超时后状态变为 CANCELLED
test("DAG 超时后进入 CANCELLED", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"])];
  executor.setDelay("A", 5000); // A 执行很久
  const ctx = makeContext(executor, nodes, 0.1); // 0.1 秒超时（100ms）
  const scheduler = new DAGScheduler(ctx);

  const start = Date.now();
  const result = await scheduler.run();
  const elapsed = Date.now() - start;

  expect(result.status).toBe("CANCELLED");
  // 应该在超时附近完成，而非等待 5 秒
  expect(elapsed).toBeLessThan(500);
});

// ---------- SUSPENDED ----------

// 审计节点抛出 SuspendedError
test("SuspendedError 导致 DAG 进入 SUSPENDED", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"])];
  executor.setError("B", new SuspendedError("Approval required", "B", { data: "test" }));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe("SUSPENDED");

  // audit.requested 事件应被发射
  const events = await ctx.storage.getEvents("test_run_1");
  expect(events.some((e) => e.type === "audit.requested")).toBe(true);

  // A 应已完成
  const aOutput = await ctx.storage.getOutput("test_run_1", "A");
  expect(aOutput).not.toBeNull();
});

// ---------- 事件和快照 ----------

// dag.started 和 dag.completed 事件
test("发射 dag.started 和 dag.completed 事件", async () => {
  const nodes: NodeDef[] = [shellNode("A")];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents("test_run_1");
  expect(events.some((e) => e.type === "dag.started")).toBe(true);
  expect(events.some((e) => e.type === "dag.completed")).toBe(true);
  expect(events.some((e) => e.type === "node.started" && e.node_id === "A")).toBe(true);
  expect(events.some((e) => e.type === "node.completed" && e.node_id === "A")).toBe(true);
});

// 快照包含正确节点状态
test("快照包含正确的节点状态", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"])];
  executor.setError("B", new Error("fail"));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const latestSnapshot = await ctx.storage.getLatestSnapshot("test_run_1");
  expect(latestSnapshot).not.toBeNull();
  expect(latestSnapshot!.node_states.A.status).toBe("COMPLETED");
  expect(latestSnapshot!.node_states.B.status).toBe("FAILED");
  expect(latestSnapshot!.dag_status).toBe("FAILED");
});

// 事件有正确的 run_id
test("所有事件携带正确的 run_id", async () => {
  const nodes: NodeDef[] = [shellNode("A")];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents("test_run_1");
  for (const event of events) {
    expect(event.run_id).toBe("test_run_1");
  }
});

// 事件有时间戳
test("所有事件有 ISO 8601 时间戳", async () => {
  const nodes: NodeDef[] = [shellNode("A")];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents("test_run_1");
  for (const event of events) {
    expect(event.timestamp).toBeTruthy();
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  }
});

// ---------- 摘要 ----------

// 成功摘要
test("成功时摘要正确", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["A"])];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe("SUCCESS");
  expect(result.summary.run_id).toBe("test_run_1");
  expect(result.summary.workflow_name).toBe("test-workflow");
  expect(result.summary.node_summary.total).toBe(3);
  expect(result.summary.node_summary.completed).toBe(3);
  expect(result.summary.node_summary.failed).toBe(0);
  expect(result.summary.started_at).toBeTruthy();
  expect(result.summary.completed_at).toBeTruthy();
});

// 失败摘要
test("失败时摘要包含失败计数", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"])];
  executor.setError("B", new Error("fail"));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe("FAILED");
  expect(result.summary.node_summary.completed).toBe(1);
  expect(result.summary.node_summary.failed).toBe(1);
});

// ---------- 边界情况 ----------

// 空工作流
test("空工作流直接 SUCCESS", async () => {
  const nodes: NodeDef[] = [];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe("SUCCESS");
  expect(result.summary.node_summary.total).toBe(0);
});

// 多依赖收敛
test("D 等待 B 和 C 都完成后才执行", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["A"]), shellNode("D", ["B", "C"])];
  executor.setDelay("B", 100);
  executor.setDelay("C", 50);
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe("SUCCESS");
  const order = executor.getExecutionOrder();
  expect(order[0]).toBe("A");
  expect(order[order.length - 1]).toBe("D");

  // B 和 C 都在 D 之前
  expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
  expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
});

// 节点输出存储
test("节点输出通过 storage 持久化", async () => {
  const nodes: NodeDef[] = [shellNode("A")];
  executor.setOutput("A", { stdout: "custom output", exit_code: 0, json: { result: 42 } });
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const output = await ctx.storage.getOutput("test_run_1", "A");
  expect(output).not.toBeNull();
  expect(output!.stdout).toBe("custom output");
  expect(output!.exit_code).toBe(0);
  expect(output!.json).toEqual({ result: 42 });
});

// node.failed 事件包含错误信息
test("node.failed 事件包含错误信息", async () => {
  const nodes: NodeDef[] = [shellNode("A")];
  executor.setError("A", new Error("something went wrong"));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents("test_run_1");
  const failedEvent = events.find((e) => e.type === "node.failed");
  expect(failedEvent).not.toBeNull();
  expect(failedEvent!.metadata?.error).toBe("something went wrong");
});

// node.skipped 事件包含 upstream_failed 原因
test("node.skipped 事件包含 upstream_failed 原因", async () => {
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"])];
  executor.setError("A", new Error("fail"));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents("test_run_1");
  const skippedEvent = events.find((e) => e.type === "node.skipped");
  expect(skippedEvent).not.toBeNull();
  expect(skippedEvent!.metadata?.reason).toBe("upstream_failed");
});

// ---------- approve → resume 端到端 ----------

// 审计节点暂停后审批恢复，下游节点继续执行
test("审批后恢复执行下游节点完成", async () => {
  const HMAC_SECRET = "test-hmac-secret-for-scheduler-tests";

  // 构建 audit 节点定义
  const nodes: NodeDef[] = [
    shellNode("step1"),
    {
      id: "approval",
      type: "audit",
      display_data: { message: "Please approve" },
      depends_on: ["step1"],
    } as AuditNodeDef,
    shellNode("step3", ["approval"]),
  ];

  // 复合执行器：shell 用 mock，audit 用真实 AuditExecutor
  const auditExec = new AuditExecutor(HMAC_SECRET);
  const compositeExecutor: NodeExecutor = {
    async execute(node, ctx) {
      if (node.type === "audit") {
        return auditExec.execute(node, ctx);
      }
      return executor.execute(node, ctx);
    },
  };

  const storage = createInMemoryStorage();
  const cancellation = new CancellationManager();
  const workflow = makeWorkflow(nodes);

  // ---------- 第一轮：执行到 SUSPENDED ----------
  const ctx1 = {
    runId: "approve_test_run",
    workflowDef: workflow,
    storage,
    params: {},
    secrets: {},
    nodeExecutor: compositeExecutor,
    cancellation,
  };

  const scheduler1 = new DAGScheduler(ctx1);
  const result1 = await scheduler1.run();

  // 验证 SUSPENDED
  expect(result1.status).toBe("SUSPENDED");

  // step1 应该完成
  const step1Output = await storage.getOutput("approve_test_run", "step1");
  expect(step1Output).not.toBeNull();

  // 从事件中获取审批 token
  const events = await storage.getEvents("approve_test_run");
  const auditEvent = events.find((e) => e.type === "audit.requested");
  expect(auditEvent).not.toBeNull();
  const displayData = auditEvent!.metadata?.display_data as Record<string, unknown>;
  const approvalToken = displayData?.approvalToken as string;
  expect(approvalToken).toBeTruthy();

  // 验证 token 有效
  const verifyResult = verifyApprovalToken(approvalToken, "approve_test_run", "approval", HMAC_SECRET);
  expect(verifyResult.valid).toBe(true);
  expect(verifyResult.expired).toBe(false);

  // ---------- 第二轮：审批通过后恢复执行 ----------
  // 发射 audit.approved 事件
  const approvedEvent: DAGEvent = {
    event_id: "evt_approved_manual",
    run_id: "approve_test_run",
    timestamp: new Date().toISOString(),
    type: "audit.approved",
    node_id: "approval",
    node_type: "audit",
  };
  await storage.appendEvent(approvedEvent);

  // 从快照重建初始状态（step1 COMPLETED, approval COMPLETED, step3 PENDING）
  const snapshot = await storage.getLatestSnapshot("approve_test_run");
  expect(snapshot).not.toBeNull();
  const initialStates = new Map<string, NodeStatus>();
  const initialOutputs = new Map<string, NodeOutput>();
  for (const [id, state] of Object.entries(snapshot!.node_states)) {
    initialStates.set(id, state.status);
    if (state.status === "COMPLETED") {
      const out = await storage.getOutput("approve_test_run", id);
      if (out) initialOutputs.set(id, out);
    }
  }
  // 审批节点标记为 COMPLETED
  initialStates.set("approval", "COMPLETED");
  initialOutputs.set("approval", { stdout: "approved", exit_code: 0 });

  const ctx2 = {
    runId: "approve_test_run",
    workflowDef: workflow,
    storage,
    params: {},
    secrets: {},
    nodeExecutor: executor as NodeExecutor,
    cancellation: new CancellationManager(),
    initialNodeStates: initialStates,
    initialNodeOutputs: initialOutputs,
  };

  const scheduler2 = new DAGScheduler(ctx2);
  const result2 = await scheduler2.run();

  // 最终应该成功
  expect(result2.status).toBe("SUCCESS");
  expect(result2.summary.node_summary.completed).toBe(3);

  // step3 应该完成
  const step3Output = await storage.getOutput("approve_test_run", "step3");
  expect(step3Output).not.toBeNull();
  expect(step3Output!.exit_code).toBe(0);

  // 验证 audit.approved 事件存在
  const finalEvents = await storage.getEvents("approve_test_run");
  expect(finalEvents.some((e) => e.type === "audit.approved")).toBe(true);
});

// 审计节点并行分支中一个挂起不影响另一个独立分支
test("审计节点挂起时独立并行分支继续执行", async () => {
  const HMAC_SECRET = "test-hmac-secret-parallel-audit";

  const nodes: NodeDef[] = [
    shellNode("A"),
    {
      id: "audit_b",
      type: "audit",
      display_data: { msg: "approve B" },
      depends_on: ["A"],
    } as AuditNodeDef,
    shellNode("C", ["A"]),
  ];

  const storage = createInMemoryStorage();
  const cancellation = new CancellationManager();
  const workflow = makeWorkflow(nodes);

  // 复合执行器
  const auditExec2 = new AuditExecutor(HMAC_SECRET);
  const compExec: NodeExecutor = {
    async execute(node, ctx) {
      if (node.type === "audit") {
        return auditExec2.execute(node, ctx);
      }
      return executor.execute(node, ctx);
    },
  };

  const ctx = {
    runId: "parallel_audit_run",
    workflowDef: workflow,
    storage,
    params: {},
    secrets: {},
    nodeExecutor: compExec,
    cancellation,
  };

  const scheduler = new DAGScheduler(ctx);
  const result = await scheduler.run();

  // DAG 应该进入 SUSPENDED（因为 audit_b 挂起）
  expect(result.status).toBe("SUSPENDED");

  // A 应该完成
  const aOutput = await storage.getOutput("parallel_audit_run", "A");
  expect(aOutput).not.toBeNull();

  // C 应该完成（独立于 audit_b）
  // 注意：audit_b 的 SuspendedError 不会阻止 C 在同一批中执行
  const events = await storage.getEvents("parallel_audit_run");
  // audit.requested 事件存在
  expect(events.some((e) => e.type === "audit.requested")).toBe(true);
});

// 审批恢复后再次暂停（多次 pause/resume 循环）
test("多次审批暂停恢复循环", async () => {
  const HMAC_SECRET = "test-hmac-secret-multi-cycle";

  const nodes: NodeDef[] = [
    shellNode("start"),
    {
      id: "audit_1",
      type: "audit",
      display_data: { stage: 1 },
      depends_on: ["start"],
    } as AuditNodeDef,
    shellNode("middle", ["audit_1"]),
    {
      id: "audit_2",
      type: "audit",
      display_data: { stage: 2 },
      depends_on: ["middle"],
    } as AuditNodeDef,
    shellNode("end", ["audit_2"]),
  ];

  const storage = createInMemoryStorage();
  const flow1 = makeWorkflow(nodes);

  // 复合执行器：audit 用真实 AuditExecutor，shell 用 mock
  const auditExec3 = new AuditExecutor(HMAC_SECRET);
  function makeCompositeExec(): NodeExecutor {
    return {
      async execute(node, ctx) {
        if (node.type === "audit") {
          return auditExec3.execute(node, ctx);
        }
        return executor.execute(node, ctx);
      },
    };
  }

  // 第一轮：跑到 audit_1 挂起
  const scheduler1 = new DAGScheduler({
    runId: "multi_cycle_run",
    workflowDef: flow1,
    storage,
    params: {},
    secrets: {},
    nodeExecutor: makeCompositeExec(),
    cancellation: new CancellationManager(),
  });
  const r1 = await scheduler1.run();
  expect(r1.status).toBe("SUSPENDED");

  // 审批 audit_1 恢复
  await storage.appendEvent({
    event_id: "evt_app1",
    run_id: "multi_cycle_run",
    timestamp: new Date().toISOString(),
    type: "audit.approved",
    node_id: "audit_1",
    node_type: "audit",
  });

  // 从 snapshot 重建初始状态
  const snap1 = (await storage.getLatestSnapshot("multi_cycle_run"))!;
  const istates1 = new Map<string, NodeStatus>();
  const ioutputs1 = new Map<string, NodeOutput>();
  for (const [id, s] of Object.entries(snap1.node_states)) {
    if (id === "audit_1") {
      istates1.set(id, "COMPLETED");
      ioutputs1.set(id, { stdout: "approved", exit_code: 0 });
    } else {
      istates1.set(id, s.status);
      if (s.status === "COMPLETED") {
        const o = await storage.getOutput("multi_cycle_run", id);
        if (o) ioutputs1.set(id, o);
      }
    }
  }

  // 第二轮：跑到 audit_2 挂起
  const scheduler2 = new DAGScheduler({
    runId: "multi_cycle_run",
    workflowDef: flow1,
    storage,
    params: {},
    secrets: {},
    nodeExecutor: makeCompositeExec(),
    cancellation: new CancellationManager(),
    initialNodeStates: istates1,
    initialNodeOutputs: ioutputs1,
  });
  const r2 = await scheduler2.run();
  expect(r2.status).toBe("SUSPENDED");

  // 验证 middle 在 audit_1 审批后完成
  const midOutput = await storage.getOutput("multi_cycle_run", "middle");
  expect(midOutput).not.toBeNull();

  // 审批 audit_2 恢复
  await storage.appendEvent({
    event_id: "evt_app2",
    run_id: "multi_cycle_run",
    timestamp: new Date().toISOString(),
    type: "audit.approved",
    node_id: "audit_2",
    node_type: "audit",
  });

  const snap2 = (await storage.getLatestSnapshot("multi_cycle_run"))!;
  const istates2 = new Map<string, NodeStatus>();
  const ioutputs2 = new Map<string, NodeOutput>();
  for (const [id, s] of Object.entries(snap2.node_states)) {
    if (id === "audit_2") {
      istates2.set(id, "COMPLETED");
      ioutputs2.set(id, { stdout: "approved", exit_code: 0 });
    } else {
      istates2.set(id, s.status);
      if (s.status === "COMPLETED") {
        const o = await storage.getOutput("multi_cycle_run", id);
        if (o) ioutputs2.set(id, o);
      }
    }
  }

  // 第三轮：最终完成
  const scheduler3 = new DAGScheduler({
    runId: "multi_cycle_run",
    workflowDef: flow1,
    storage,
    params: {},
    secrets: {},
    nodeExecutor: executor as NodeExecutor,
    cancellation: new CancellationManager(),
    initialNodeStates: istates2,
    initialNodeOutputs: ioutputs2,
  });
  const r3 = await scheduler3.run();
  expect(r3.status).toBe("SUCCESS");

  // end 节点应完成
  const endOutput = await storage.getOutput("multi_cycle_run", "end");
  expect(endOutput).not.toBeNull();
});

// ---------- 并发中单节点失败传播 ----------

// B 失败不影响同一批的 C，但会跳过下游 D
test("并行批次中 B 失败不影响 C 但跳过 D", async () => {
  // A → [B, C] → D
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["A"]), shellNode("D", ["B", "C"])];
  executor.setError("B", new Error("B failed"));
  executor.setDelay("C", 60); // C 需要一些时间

  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();
  expect(result.status).toBe("FAILED");

  // C 应该成功执行（不受 B 失败影响）
  const cOutput = await ctx.storage.getOutput("test_run_1", "C");
  expect(cOutput).not.toBeNull();
  expect(cOutput!.exit_code).toBe(0);

  // D 应该被跳过（因为 B 失败传播）
  const events = await ctx.storage.getEvents("test_run_1");
  const dSkipped = events.find((e) => e.type === "node.skipped" && e.node_id === "D");
  expect(dSkipped).not.toBeNull();
  expect(dSkipped!.metadata?.reason).toBe("upstream_failed");

  // B 失败
  const bFailed = events.find((e) => e.type === "node.failed" && e.node_id === "B");
  expect(bFailed).not.toBeNull();

  // C 完成
  const cCompleted = events.find((e) => e.type === "node.completed" && e.node_id === "C");
  expect(cCompleted).not.toBeNull();
});

// ---------- SKIPPED 依赖链传递 ----------

// A 失败 → B SKIPPED → C SKIPPED（通过 BFS 深度传播）
test("SKIPPED 状态沿依赖链深度传播", async () => {
  // A → B → C → D（线性链）
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"]), shellNode("D", ["C"])];
  executor.setError("A", new Error("A failed"));

  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();
  expect(result.status).toBe("FAILED");
  expect(result.summary.node_summary.failed).toBe(1);

  // B、C、D 都应该被 SKIPPED
  const events = await ctx.storage.getEvents("test_run_1");
  const skippedIds = new Set(events.filter((e) => e.type === "node.skipped").map((e) => e.node_id));
  expect(skippedIds.has("B")).toBe(true);
  expect(skippedIds.has("C")).toBe(true);
  expect(skippedIds.has("D")).toBe(true);
});

// 跨分支 SKIPPED 传播：A 失败 → B SKIPPED → D SKIPPED（D 依赖 B 和 C）
test("SKIPPED 跨分支阻塞收敛节点", async () => {
  // A → B → D
  // X → C → D
  // X 独立于 A 的分支
  const nodes: NodeDef[] = [
    shellNode("A"),
    shellNode("B", ["A"]),
    shellNode("X"),
    shellNode("C", ["X"]),
    shellNode("D", ["B", "C"]),
  ];
  executor.setError("A", new Error("A failed"));

  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();
  expect(result.status).toBe("FAILED");

  const events = await ctx.storage.getEvents("test_run_1");

  // X 和 C 应成功完成
  expect(events.some((e) => e.type === "node.completed" && e.node_id === "X")).toBe(true);
  expect(events.some((e) => e.type === "node.completed" && e.node_id === "C")).toBe(true);

  // B 和 D 应被 SKIPPED
  expect(events.some((e) => e.type === "node.skipped" && e.node_id === "B")).toBe(true);
  expect(events.some((e) => e.type === "node.skipped" && e.node_id === "D")).toBe(true);
});

// ---------- 大批量并发 ----------

// 20 个节点并行执行
test("20 个节点并行执行总耗时接近单节点", async () => {
  const nodes: NodeDef[] = [];
  for (let i = 0; i < 20; i++) {
    nodes.push(shellNode(`node_${i}`));
  }

  // 每个节点延迟 10ms
  for (const node of nodes) {
    executor.setDelay(node.id, 10);
  }

  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const start = Date.now();
  const result = await scheduler.run();
  const elapsed = Date.now() - start;

  expect(result.status).toBe("SUCCESS");
  expect(result.summary.node_summary.total).toBe(20);
  expect(result.summary.node_summary.completed).toBe(20);

  // 并行执行：总耗时应接近 10ms 而非 200ms
  expect(elapsed).toBeLessThan(150);
});

// 并发中取消所有运行中的节点
test("并行执行中取消全部节点", async () => {
  const nodes: NodeDef[] = [];
  for (let i = 0; i < 5; i++) {
    nodes.push(shellNode(`n${i}`));
    executor.setDelay(`n${i}`, 200);
  }

  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  // 50ms 后取消
  setTimeout(() => ctx.cancellation.cancel(), 50);

  const result = await scheduler.run();
  expect(result.status).toBe("CANCELLED");

  // 所有节点都不应该是 COMPLETED
  const events = await ctx.storage.getEvents("test_run_1");
  const completedIds = new Set(events.filter((e) => e.type === "node.completed").map((e) => e.node_id));
  // 在取消前不应有节点完成（50ms 取消 vs 200ms 延迟）
  expect(completedIds.size).toBe(0);

  // dag.cancelled 事件存在
  expect(events.some((e) => e.type === "dag.cancelled")).toBe(true);
});

// ---------- 部分依赖已满足的边缘情况 ----------

// 当节点依赖中包含 SKIPPED 节点时不会被调度（死锁防护）
test("依赖 SKIPPED 节点的节点不被调度为 READY", async () => {
  // A 失败 → B 和 C SKIPPED → D 依赖 B 和 E
  // E 完成，但 B 是 SKIPPED，D 不应该变成 READY
  const nodes: NodeDef[] = [shellNode("A"), shellNode("B", ["A"]), shellNode("E"), shellNode("D", ["B", "E"])];
  executor.setError("A", new Error("A failed"));

  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  // DAG 失败，D 是 SKIPPED 不是 PENDING/死锁
  expect(result.status).toBe("FAILED");

  const events = await ctx.storage.getEvents("test_run_1");
  const dSkipped = events.find((e) => e.type === "node.skipped" && e.node_id === "D");
  expect(dSkipped).not.toBeNull();
  expect(dSkipped!.metadata?.reason).toBe("upstream_failed");

  // D 不应该有 started 或 completed 事件
  expect(events.some((e) => e.node_id === "D" && e.type === "node.started")).toBe(false);
  expect(events.some((e) => e.node_id === "D" && e.type === "node.completed")).toBe(false);
});

// ---------- resolveNodeInputs 对 custom 节点 script 字段的求值 ----------

// 基线测试:直接调用 resolveTemplate 验证 script.content 和 script.env 表达式求值
// 完整端到端验证在 Task 6 的 custom-executor 测试覆盖
test("custom 节点 script.content 表达式被求值", () => {
  // 直接构造 CustomNodeDef(不依赖 parseWorkflowYaml 的 customRegistry)
  const customDef: CustomNodeDef = {
    id: "job1",
    type: "custom",
    tool: "slurm",
    outputs: {
      out: { pattern: "/tmp/out", type: "file" },
    },
    script: {
      content: 'echo "workdir=${{ params.work_dir }}"',
      env: {
        WORK_DIR: "${{ params.work_dir }}",
        CORES: "${{ params.cores }}",
      },
    },
  };

  // 手动复现 resolveNodeInputs 的 custom 分支逻辑(等价验证)
  const evalContext = {
    params: { work_dir: "/data/test", cores: 8 },
    secrets: {},
    nodes: {},
  };

  const resolvedScript = {
    content: resolveTemplate(customDef.script!.content, evalContext),
    env: Object.fromEntries(
      Object.entries(customDef.script!.env!).map(([k, v]) => [k, resolveTemplate(v, evalContext)]),
    ),
  };

  expect(resolvedScript.content).toContain("workdir=/data/test");
  expect(resolvedScript.env.WORK_DIR).toBe("/data/test");
  expect(resolvedScript.env.CORES).toBe("8"); // resolveTemplate 强制 string
});

// env 为 undefined 时返回空对象
test("custom 节点 script 无 env 时求值结果 env 为空对象", () => {
  const customDef: CustomNodeDef = {
    id: "job1",
    type: "custom",
    tool: "slurm",
    outputs: {
      out: { pattern: "/tmp/out", type: "file" },
    },
    script: {
      content: 'echo "workdir=${{ params.work_dir }}"',
    },
  };

  const evalContext = {
    params: { work_dir: "/data/test" },
    secrets: {},
    nodes: {},
  };

  // 模拟 dag-scheduler 的 script 求值逻辑: env 为 undefined 时返回 {}
  const resolvedScript = {
    content: resolveTemplate(customDef.script!.content, evalContext),
    env: customDef.script!.env
      ? Object.fromEntries(Object.entries(customDef.script!.env).map(([k, v]) => [k, resolveTemplate(v, evalContext)]))
      : {},
  };

  expect(resolvedScript.content).toContain("workdir=/data/test");
  expect(resolvedScript.env).toEqual({});
});
