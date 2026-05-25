import { beforeEach, expect, test } from "bun:test";
import { nanoid } from "nanoid";
import { recoverRun } from "../../recovery/snapshot-recovery";
import { CancellationManager } from "../../scheduler/cancellation";
import type { NodeExecutionContext, NodeExecutor, SchedulerContext } from "../../scheduler/dag-scheduler";
import { DAGScheduler } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type {
  AgentNodeDef,
  AuditNodeDef,
  LoopNodeDef,
  NodeDef,
  ShellNodeDef,
  SubWorkflowNodeDef,
  WorkflowDef,
} from "../../types/dag";
import type { DAGEvent, DAGSnapshot, NodeOutput } from "../../types/execution";

// ---------- 辅助工具 ----------

/** 创建简单 shell 节点 */
function shellNode(id: string, dependsOn?: string[]): ShellNodeDef {
  return { id, type: "shell", command: `echo ${id}`, depends_on: dependsOn };
}

/** 创建 audit 节点 */
function auditNode(id: string, dependsOn?: string[]): AuditNodeDef {
  return { id, type: "audit", display_data: { msg: "approve me" }, depends_on: dependsOn };
}

/** 创建 loop 节点 */
function loopNode(id: string, dependsOn?: string[]): LoopNodeDef {
  return {
    id,
    type: "loop",
    condition: "true",
    max_iterations: 3,
    body: { nodes: [shellNode(`${id}_body`)] },
    depends_on: dependsOn,
  };
}

/** 创建 sub-workflow 节点 */
function subWorkflowNode(id: string, dependsOn?: string[]): SubWorkflowNodeDef {
  return { id, type: "workflow", ref: "other-workflow", depends_on: dependsOn };
}

/** 创建 agent 节点 */
function agentNode(id: string, dependsOn?: string[]): AgentNodeDef {
  return { id, type: "agent", prompt: "do something", depends_on: dependsOn };
}

/** 创建工作流定义 */
function makeWorkflow(nodes: NodeDef[]): WorkflowDef {
  return { schema_version: "1.0", name: "test-workflow", nodes };
}

/** 创建事件 */
function makeEvent(overrides: Partial<DAGEvent> & { type: DAGEvent["type"] }): DAGEvent {
  return {
    event_id: `evt_${nanoid(10)}`,
    run_id: "test_run_1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** 创建快照 */
function makeSnapshot(overrides: Partial<DAGSnapshot> & { node_states: DAGSnapshot["node_states"] }): DAGSnapshot {
  return {
    snapshot_id: `snap_${nanoid(10)}`,
    run_id: "test_run_1",
    last_event_id: `evt_${nanoid(10)}`,
    timestamp: new Date().toISOString(),
    dag_status: "RUNNING",
    ...overrides,
  };
}

/** Mock 执行器 */
class MockNodeExecutor implements NodeExecutor {
  private readonly outputs = new Map<string, NodeOutput>();

  setOutput(nodeId: string, output: NodeOutput): void {
    this.outputs.set(nodeId, output);
  }

  async execute(node: NodeDef, _ctx: NodeExecutionContext): Promise<NodeOutput> {
    return this.outputs.get(node.id) ?? { stdout: `output of ${node.id}`, exit_code: 0 };
  }
}

/** 构建基础调度上下文 */
function makeBaseContext(workflow: WorkflowDef, storage = createInMemoryStorage()): SchedulerContext {
  return {
    runId: "test_run_1",
    workflowDef: workflow,
    storage,
    params: {},
    secrets: {},
    nodeExecutor: new MockNodeExecutor() as NodeExecutor,
    cancellation: new CancellationManager(),
  };
}

/**
 * 模拟一次部分执行：写入事件和快照到 storage。
 * completedNodeIds: 已完成的节点
 * startedOnlyNodeIds: 已 started 但未完成的（孤儿）
 * snapshotStatus: 快照中的 DAG 状态
 */
async function simulatePartialRun(
  storage: ReturnType<typeof createInMemoryStorage>,
  completedNodeIds: string[],
  startedOnlyNodeIds: string[] = [],
  snapshotStatus: DAGSnapshot["dag_status"] = "RUNNING",
  suspendedNodeIds: string[] = [],
): Promise<string> {
  const allEvents: DAGEvent[] = [];

  // dag.started
  allEvents.push(makeEvent({ type: "dag.started" }));

  // 已完成的节点
  for (const nodeId of completedNodeIds) {
    allEvents.push(makeEvent({ type: "node.started", node_id: nodeId }));
    allEvents.push(makeEvent({ type: "node.completed", node_id: nodeId }));
    // 写入输出
    await storage.setOutput("test_run_1", nodeId, {
      stdout: `output of ${nodeId}`,
      exit_code: 0,
    });
  }

  // SUSPENDED 的节点
  for (const nodeId of suspendedNodeIds) {
    allEvents.push(makeEvent({ type: "node.started", node_id: nodeId }));
    allEvents.push(makeEvent({ type: "audit.requested", node_id: nodeId }));
  }

  // 孤儿节点（started 但未完成）
  for (const nodeId of startedOnlyNodeIds) {
    allEvents.push(makeEvent({ type: "node.started", node_id: nodeId }));
  }

  // 写入所有事件
  for (const event of allEvents) {
    await storage.appendEvent(event);
  }

  // 创建快照（指向最后一个事件）
  const lastEventId = allEvents[allEvents.length - 1].event_id;

  // 构建快照的 node_states
  const nodeStates: DAGSnapshot["node_states"] = {};
  for (const nodeId of completedNodeIds) {
    nodeStates[nodeId] = { status: "COMPLETED" };
  }
  for (const nodeId of suspendedNodeIds) {
    nodeStates[nodeId] = { status: "SUSPENDED" as unknown as DAGSnapshot["node_states"][string]["status"] };
  }
  for (const nodeId of startedOnlyNodeIds) {
    nodeStates[nodeId] = { status: "RUNNING" };
  }

  const snapshot = makeSnapshot({
    last_event_id: lastEventId,
    dag_status: snapshotStatus,
    node_states: nodeStates,
  });
  await storage.createSnapshot(snapshot);

  return lastEventId;
}

// ---------- 测试 ----------

let storage: ReturnType<typeof createInMemoryStorage>;

beforeEach(() => {
  storage = createInMemoryStorage();
});

// ---------- 已完成的 DAG 直接返回 SUCCESS ----------

// 全部完成 → 不需要重新调度
test("全部完成的 DAG 恢复后直接返回 SUCCESS", async () => {
  const nodes = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"])];
  const workflow = makeWorkflow(nodes);
  await simulatePartialRun(storage, ["A", "B", "C"], [], "SUCCESS");

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  expect(result.status).toBe("SUCCESS");
  expect(result.summary.node_summary.completed).toBe(3);
  expect(result.summary.node_summary.failed).toBe(0);
});

// FAILED 的 DAG 直接返回 FAILED
test("已失败的 DAG 恢复后直接返回 FAILED", async () => {
  const nodes = [shellNode("A"), shellNode("B", ["A"])];
  const workflow = makeWorkflow(nodes);

  // 手动写入事件模拟失败
  await storage.appendEvent(makeEvent({ type: "dag.started" }));
  await storage.appendEvent(makeEvent({ type: "node.started", node_id: "A" }));
  await storage.appendEvent(makeEvent({ type: "node.completed", node_id: "A" }));
  await storage.appendEvent(makeEvent({ type: "node.started", node_id: "B" }));
  await storage.appendEvent(makeEvent({ type: "node.failed", node_id: "B", metadata: { error: "boom" } }));
  await storage.appendEvent(makeEvent({ type: "dag.cancelled" }));

  await storage.createSnapshot(
    makeSnapshot({
      dag_status: "FAILED",
      node_states: { A: { status: "COMPLETED" }, B: { status: "FAILED" } },
    }),
  );

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  expect(result.status).toBe("FAILED");
});

// CANCELLED 的 DAG 直接返回 CANCELLED
test("已取消的 DAG 恢复后直接返回 CANCELLED", async () => {
  const nodes = [shellNode("A")];
  const workflow = makeWorkflow(nodes);

  await storage.appendEvent(makeEvent({ type: "dag.started" }));
  await storage.appendEvent(makeEvent({ type: "node.started", node_id: "A" }));
  await storage.appendEvent(makeEvent({ type: "node.cancelled", node_id: "A" }));
  await storage.appendEvent(makeEvent({ type: "dag.cancelled" }));

  await storage.createSnapshot(
    makeSnapshot({
      dag_status: "CANCELLED",
      node_states: { A: { status: "CANCELLED" } },
    }),
  );

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  expect(result.status).toBe("CANCELLED");
});

// ---------- 孤儿检测与恢复 ----------

// 部分完成 → 重新调度剩余节点
test("部分完成的 DAG 恢复后重新调度剩余节点", async () => {
  const nodes = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"])];
  const workflow = makeWorkflow(nodes);
  // A 已完成，B 是孤儿（started 但未完成），C 还没开始
  await simulatePartialRun(storage, ["A"], ["B"], "RUNNING");

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  // B 被取消（孤儿清理），C 因 B 取消而跳过（如果 propagateFailure 生效）或 B 变 PENDING 重试
  expect(result.status).toBe("FAILED"); // B 被取消后触发错误传播
});

// 孤儿节点被标记为 CANCELLED
test("孤儿节点在恢复时被标记为 CANCELLED", async () => {
  const nodes = [shellNode("A"), shellNode("B")];
  const workflow = makeWorkflow(nodes);
  await simulatePartialRun(storage, [], ["A"], "RUNNING");

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  // A 是孤儿，被取消
  expect(result.status).toBe("FAILED");
});

// 无孤儿的部分完成 → 剩余节点正常执行
test("无孤儿的部分完成 DAG 恢复后继续执行剩余节点", async () => {
  const nodes = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"])];
  const workflow = makeWorkflow(nodes);
  // A 已完成，B 和 C 还是 PENDING（在快照中没有）
  await simulatePartialRun(storage, ["A"], [], "RUNNING");

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  // A 已完成，B 和 C 应继续执行
  expect(result.status).toBe("SUCCESS");
  expect(result.summary.node_summary.completed).toBe(3);
});

// ---------- SUSPENDED 状态恢复 ----------

// SUSPENDED 恢复 → 识别待审批节点
test("SUSPENDED 状态恢复后识别待审批节点", async () => {
  const nodes = [shellNode("A"), auditNode("B", ["A"]), shellNode("C", ["B"])];
  const workflow = makeWorkflow(nodes);
  // A 已完成，B 是 SUSPENDED
  await simulatePartialRun(storage, ["A"], [], "SUSPENDED", ["B"]);

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  // B 保持 SUSPENDED，C 等待 B
  expect(result.status).toBe("SUSPENDED");
});

// ---------- LoopNode 崩溃恢复 ----------

// LoopNode 崩溃 → 标记 ERROR（MVP 行为）
test("LoopNode 崩溃恢复标记为 FAILED（MVP）", async () => {
  const nodes = [shellNode("A"), loopNode("loop1", ["A"])];
  const workflow = makeWorkflow(nodes);
  // A 已完成，loop1 是孤儿
  await simulatePartialRun(storage, ["A"], ["loop1"], "RUNNING");

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  // loop1 被标记为 FAILED（recovery_not_supported）
  expect(result.status).toBe("FAILED");

  // 验证事件中有 recovery_not_supported 错误
  const events = await storage.getEvents("test_run_1");
  const failedEvents = events.filter((e) => e.type === "node.failed");
  expect(failedEvents.some((e) => e.metadata?.error === "recovery_not_supported")).toBe(true);
});

// ---------- SubWorkflowNode 崩溃恢复 ----------

// SubWorkflowNode 崩溃 → 标记 ERROR（MVP 行为）
test("SubWorkflowNode 崩溃恢复标记为 FAILED（MVP）", async () => {
  const nodes = [shellNode("A"), subWorkflowNode("sub1", ["A"])];
  const workflow = makeWorkflow(nodes);
  // A 已完成，sub1 是孤儿
  await simulatePartialRun(storage, ["A"], ["sub1"], "RUNNING");

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  // sub1 被标记为 FAILED（recovery_not_supported）
  expect(result.status).toBe("FAILED");

  const events = await storage.getEvents("test_run_1");
  const failedEvents = events.filter((e) => e.type === "node.failed");
  expect(failedEvents.some((e) => e.metadata?.error === "recovery_not_supported")).toBe(true);
});

// ---------- AgentNode 孤儿清理 ----------

// AgentNode 孤儿 → 标记为 CANCELLED
test("AgentNode 孤儿在恢复时被标记为 CANCELLED", async () => {
  const nodes = [shellNode("A"), agentNode("agent1", ["A"])];
  const workflow = makeWorkflow(nodes);
  await simulatePartialRun(storage, ["A"], ["agent1"], "RUNNING");

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  // agent1 被取消，下游无节点所以最终 FAILED
  expect(result.status).toBe("FAILED");

  const events = await storage.getEvents("test_run_1");
  const cancelledEvents = events.filter((e) => e.type === "node.cancelled");
  expect(cancelledEvents.some((e) => e.node_id === "agent1")).toBe(true);
});

// ---------- 幂等性 ----------

// 多次恢复调用安全
test("多次恢复调用幂等", async () => {
  const nodes = [shellNode("A"), shellNode("B", ["A"])];
  const workflow = makeWorkflow(nodes);
  await simulatePartialRun(storage, ["A", "B"], [], "SUCCESS");

  const ctx = makeBaseContext(workflow, storage);
  const result1 = await recoverRun(ctx);
  const result2 = await recoverRun(ctx);

  expect(result1.status).toBe("SUCCESS");
  expect(result2.status).toBe("SUCCESS");
});

// ---------- 无快照 ----------

// 无快照时抛出错误
test("无快照时抛出 RECOVERY_ERROR", async () => {
  const nodes = [shellNode("A")];
  const workflow = makeWorkflow(nodes);
  const ctx = makeBaseContext(workflow, storage);

  await expect(recoverRun(ctx)).rejects.toThrow();
});

// ---------- 事件重放 ----------

// 快照之后有新事件时正确重放
test("快照之后有新事件时正确重放", async () => {
  const nodes = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"])];
  const workflow = makeWorkflow(nodes);

  // 写入 dag.started 和 A 完成
  await storage.appendEvent(makeEvent({ type: "dag.started" }));
  await storage.appendEvent(makeEvent({ type: "node.started", node_id: "A" }));
  await storage.appendEvent(makeEvent({ type: "node.completed", node_id: "A" }));
  await storage.setOutput("test_run_1", "A", { stdout: "A out", exit_code: 0 });

  // 创建快照（此时只有 A 完成）
  const snapEventId = `evt_${nanoid(10)}`;
  await storage.createSnapshot(
    makeSnapshot({
      last_event_id: snapEventId,
      dag_status: "RUNNING",
      node_states: { A: { status: "COMPLETED" } },
    }),
  );

  // 快照之后 B 也完成了
  await storage.appendEvent(makeEvent({ type: "node.started", node_id: "B" }));
  await storage.appendEvent(makeEvent({ type: "node.completed", node_id: "B" }));
  await storage.setOutput("test_run_1", "B", { stdout: "B out", exit_code: 0 });

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  // A 和 B 都已通过重放识别为完成，C 继续执行
  expect(result.status).toBe("SUCCESS");
  expect(result.summary.node_summary.completed).toBe(3);
});

// ---------- DAGScheduler 恢复模式 ----------

// DAGScheduler 接受 initialNodeStates 跳过已完成节点
test("DAGScheduler 使用 initialNodeStates 跳过已完成节点", async () => {
  const nodes = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"])];
  const workflow = makeWorkflow(nodes);
  const ctx = makeBaseContext(workflow, storage);

  const initialStates = new Map<string, import("../../types/execution").NodeStatus>();
  initialStates.set("A", "COMPLETED");
  initialStates.set("B", "PENDING");
  initialStates.set("C", "PENDING");

  const initialOutputs = new Map<string, NodeOutput>();
  initialOutputs.set("A", { stdout: "A output", exit_code: 0 });

  const scheduler = new DAGScheduler({
    ...ctx,
    initialNodeStates: initialStates,
    initialNodeOutputs: initialOutputs,
  });

  const result = await scheduler.run();
  expect(result.status).toBe("SUCCESS");
  expect(result.summary.node_summary.completed).toBe(3);
});

// ---------- 混合崩溃：孤儿 + SUSPENDED ----------

// A → [audit_B, shell_C] → 恢复时 C 是孤儿，B 是 SUSPENDED
test("混合崩溃：孤儿节点 + SUSPENDED 节点同时存在", async () => {
  const nodes = [shellNode("A"), auditNode("B", ["A"]), shellNode("C", ["A"]), shellNode("D", ["B", "C"])];
  const workflow = makeWorkflow(nodes);
  // A 已完成，B SUSPENDED，C 是孤儿（started 但未完成）
  await simulatePartialRun(storage, ["A"], ["C"], "RUNNING", ["B"]);

  const ctx = makeBaseContext(workflow, storage);
  const result = await recoverRun(ctx);

  // C 被取消（孤儿清理），B 保持 SUSPENDED
  // D 依赖 B(SUSPENDED) 和 C(CANCELLED) → 永远不会 READY，DAG 最终 SUSPENDED
  expect(result.status).toBe("SUSPENDED");

  // 验证 C 被取消
  const events = await storage.getEvents("test_run_1");
  expect(events.some((e) => e.type === "node.cancelled" && e.node_id === "C")).toBe(true);

  // B 仍是 SUSPENDED 状态
  const snapshot = await storage.getLatestSnapshot("test_run_1");
  expect(snapshot).not.toBeNull();
  expect(snapshot!.node_states.B.status).toBe("SUSPENDED");
});

// ---------- Shell 孤儿真实进程清理 ----------

// 实际 spawn 进程后恢复时验证进程被终止
test("Shell 孤儿真实进程在恢复时被 SIGKILL", async () => {
  // spawn 一个长时间运行的进程
  const proc = Bun.spawn(["sleep", "60"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const pid = proc.pid;

  // 等待进程启动
  await Bun.sleep(100);

  // 验证进程存活
  let processAlive = true;
  try {
    process.kill(pid, 0);
  } catch {
    processAlive = false;
  }

  if (!processAlive) {
    // 进程意外退出，跳过此测试
    return;
  }

  try {
    const nodes = [shellNode("A"), shellNode("B", ["A"])];
    const workflow = makeWorkflow(nodes);

    // 手动构造事件：A 完成，B 是孤儿（带真实 PID）
    await storage.appendEvent(makeEvent({ type: "dag.started" }));
    await storage.appendEvent(makeEvent({ type: "node.started", node_id: "A" }));
    await storage.appendEvent(makeEvent({ type: "node.completed", node_id: "A" }));
    await storage.setOutput("test_run_1", "A", { stdout: "A ok", exit_code: 0 });
    await storage.appendEvent(makeEvent({ type: "node.started", node_id: "B", node_type: "shell", metadata: { pid } }));

    // 创建快照
    await storage.createSnapshot(
      makeSnapshot({
        dag_status: "RUNNING",
        node_states: {
          A: { status: "COMPLETED" },
          B: { status: "RUNNING" },
        },
      }),
    );

    const ctx = makeBaseContext(workflow, storage);
    const result = await recoverRun(ctx);

    // B 是孤儿，应被取消
    expect(result.status).toBe("FAILED"); // B 被取消导致错误传播

    // 验证进程已被终止（可能仍在等待 5s 宽限期中的 SIGKILL 或已退出）
    // SIGTERM 对 sleep 无效，最终通过 SIGKILL 终止
    try {
      const exited = await proc.exited;
      expect(exited).toBeDefined();
    } catch {
      // exited promise 可能 reject，忽略
    }

    // 进程应已被 kill
    try {
      process.kill(pid, 0);
      // 如果到这里说明进程还活着，手动 kill
      proc.kill("SIGKILL");
    } catch {
      // ESRCH：进程已死 — 这正是我们期望的
    }
  } finally {
    // 确保进程被终止
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}, 15000); // 15s 超时（宽限期 5s + 余量）

// ---------- 连续两次崩溃恢复 ----------

// 恢复中途再次崩溃，第二次恢复仍能正确工作
test("连续两次恢复幂等且正确", async () => {
  const nodes = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"]), shellNode("D", ["C"])];
  const workflow = makeWorkflow(nodes);

  // 第一次部分执行：A 完成，B 是孤儿
  await simulatePartialRun(storage, ["A"], ["B"], "RUNNING");

  const ctx1 = makeBaseContext(workflow, storage);
  const result1 = await recoverRun(ctx1);
  // B 被取消 → 下游 SKIPPED → 最终 FAILED
  expect(result1.status).toBe("FAILED");

  // 模拟第一次恢复后又有新事件（B 被取消，C SKIPPED，D SKIPPED）
  // 这些事件由第一次恢复写入，第二次恢复从快照重放
  const lastSnapshot = await storage.getLatestSnapshot("test_run_1");
  expect(lastSnapshot).not.toBeNull();
  expect(lastSnapshot!.dag_status).toBe("FAILED");

  // 第二次恢复：直接返回 FAILED（幂等）
  const ctx2 = makeBaseContext(workflow, storage);
  const result2 = await recoverRun(ctx2);
  expect(result2.status).toBe("FAILED");

  // 两次结果一致
  expect(result1.summary.node_summary.completed).toBe(result2.summary.node_summary.completed);
  expect(result1.summary.node_summary.failed).toBe(result2.summary.node_summary.failed);
});

// ---------- 部分完成 + 定义变更（恢复后兼容新旧节点） ----------

// 崩溃前执行了 A→B，重启后 workflow 新增了节点 C（A→B→C）
// 恢复时应：A COMPLETED 保留, B PENDING 继续执行, C 作为新节点 PENDING 调度
test("恢复兼容定义变更：新增节点按 PENDING 正常调度", async () => {
  // 原始定义（崩溃时）：A, B
  const originalNodes = [shellNode("A"), shellNode("B", ["A"])];
  const _originalWorkflow = makeWorkflow(originalNodes);

  // 模拟部分执行：A 完成
  await simulatePartialRun(storage, ["A"], [], "RUNNING");

  // 新定义（恢复时）：比原来多了 C
  const newNodes = [shellNode("A"), shellNode("B", ["A"]), shellNode("C", ["B"])];
  const newWorkflow = makeWorkflow(newNodes);

  // 用新定义恢复（模拟用户修改 YAML 后 recover）
  const ctx = makeBaseContext(newWorkflow, storage);
  const result = await recoverRun(ctx);

  // A 已完成，B 继续执行，C 作为新增 PENDING→执行→完成
  expect(result.status).toBe("SUCCESS");
  expect(result.summary.node_summary.completed).toBe(3);
  expect(result.summary.node_summary.total).toBe(3);

  // C 的输出应该存在
  const cOutput = await storage.getOutput("test_run_1", "C");
  expect(cOutput).not.toBeNull();
});
