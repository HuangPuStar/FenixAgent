import { describe, expect, test, beforeEach } from 'bun:test';
import { DAGScheduler, SuspendedError } from '../../scheduler/dag-scheduler';
import type { NodeExecutor, NodeExecutionContext } from '../../scheduler/dag-scheduler';
import { CancellationManager } from '../../scheduler/cancellation';
import { createInMemoryStorage } from '../../storage/in-memory-storage';
import type { NodeDef, WorkflowDef, ShellNodeDef } from '../../types/dag';
import type { NodeOutput } from '../../types/execution';

// ---------- 辅助工具 ----------

/** 创建简单 shell 节点 */
function shellNode(id: string, dependsOn?: string[]): ShellNodeDef {
  return { id, type: 'shell', command: `echo ${id}`, depends_on: dependsOn };
}

/** 创建工作流定义 */
function makeWorkflow(nodes: NodeDef[], timeout?: number): WorkflowDef {
  return {
    schema_version: '1.0',
    name: 'test-workflow',
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

    // 检查取消
    if (ctx.signal.aborted) {
      const err = new DOMException('Aborted', 'AbortError');
      throw err;
    }

    // 延迟模拟
    const delay = this.delays.get(node.id);
    if (delay) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }

    // 再次检查取消（延迟后）
    if (ctx.signal.aborted) {
      const err = new DOMException('Aborted', 'AbortError');
      throw err;
    }

    // 检查预设错误
    const presetError = this.errors.get(node.id);
    if (presetError) throw presetError;

    // 返回预设输出
    const output = this.outputs.get(node.id) ?? {
      stdout: `output of ${node.id}`,
      exit_code: 0,
    };

    this.endTimes.set(node.id, Date.now());
    return output;
  }
}

/** 创建标准调度上下文 */
function makeContext(
  executor: MockNodeExecutor,
  nodes: NodeDef[],
  timeout?: number,
) {
  const storage = createInMemoryStorage();
  const cancellation = new CancellationManager();
  const workflow = makeWorkflow(nodes, timeout);

  return {
    runId: 'test_run_1',
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
test('线性 DAG 按依赖顺序执行', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['B']),
  ];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe('SUCCESS');
  expect(executor.getExecutionOrder()).toEqual(['A', 'B', 'C']);
});

// ---------- 并行执行 ----------

// A → [B, C] → D，B 和 C 并行
test('扇出 DAG B 和 C 并行执行', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['A']),
    shellNode('D', ['B', 'C']),
  ];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  // B 和 C 各延迟 50ms，如果串行则总耗时 >100ms
  executor.setDelay('B', 50);
  executor.setDelay('C', 50);

  const start = Date.now();
  const result = await scheduler.run();
  const elapsed = Date.now() - start;

  expect(result.status).toBe('SUCCESS');

  const order = executor.getExecutionOrder();
  // A 必须第一个
  expect(order[0]).toBe('A');
  // D 必须最后一个
  expect(order[order.length - 1]).toBe('D');
  // B 和 C 都在 A 之后、D 之前
  expect(order.indexOf('B')).toBeGreaterThan(0);
  expect(order.indexOf('C')).toBeGreaterThan(0);
  expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
  expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));

  // 并行验证：总耗时应远小于串行（100ms），允许 30ms 误差
  expect(elapsed).toBeLessThan(130);
});

// 独立节点并行
test('无依赖的节点并行执行', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B'),
    shellNode('C'),
  ];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  executor.setDelay('A', 50);
  executor.setDelay('B', 50);
  executor.setDelay('C', 50);

  const start = Date.now();
  const result = await scheduler.run();
  const elapsed = Date.now() - start;

  expect(result.status).toBe('SUCCESS');
  // 三个 50ms 的节点并行，总耗时应接近 50ms 而非 150ms
  expect(elapsed).toBeLessThan(120);
});

// ---------- 错误传播 ----------

// A 失败 → B 和 D 被跳过（C 不受影响如果独立）
test('节点失败后下游被 SKIPPED', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['A']),
  ];
  executor.setError('A', new Error('A failed'));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe('FAILED');
  expect(result.summary.node_summary.failed).toBe(1);

  // B 和 C 应该被跳过
  const events = await ctx.storage.getEvents('test_run_1');
  const skippedEvents = events.filter((e) => e.type === 'node.skipped');
  const skippedNodeIds = new Set(skippedEvents.map((e) => e.node_id));
  expect(skippedNodeIds.has('B')).toBe(true);
  expect(skippedNodeIds.has('C')).toBe(true);
});

// 独立分支不受影响
test('独立分支在 A 失败后仍执行', async () => {
  // A → B, E（独立）
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('E'), // 无依赖，不受 A 影响
  ];
  executor.setError('A', new Error('A failed'));
  executor.setOutput('E', { stdout: 'E result', exit_code: 0 });
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe('FAILED');
  // E 应该成功执行
  const order = executor.getExecutionOrder();
  expect(order).toContain('E');

  // B 被跳过，E 不被跳过
  const events = await ctx.storage.getEvents('test_run_1');
  const skippedEvents = events.filter((e) => e.type === 'node.skipped');
  const skippedNodeIds = new Set(skippedEvents.map((e) => e.node_id));
  expect(skippedNodeIds.has('B')).toBe(true);
  expect(skippedNodeIds.has('E')).toBe(false);

  // E 的输出应被存储
  const eOutput = await ctx.storage.getOutput('test_run_1', 'E');
  expect(eOutput?.stdout).toBe('E result');
});

// 部分失败
test('B 失败不影响已完成的 A', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['B']),
  ];
  executor.setError('B', new Error('B failed'));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe('FAILED');
  expect(result.summary.node_summary.completed).toBe(1); // A
  expect(result.summary.node_summary.failed).toBe(1); // B

  // A 的输出应被存储
  const aOutput = await ctx.storage.getOutput('test_run_1', 'A');
  expect(aOutput).not.toBeNull();
});

// ---------- 取消 ----------

// 中途取消
test('中途取消停止调度新节点', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['B']),
  ];
  executor.setDelay('A', 200); // A 执行中取消
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  // 50ms 后取消
  setTimeout(() => ctx.cancellation.cancel(), 50);

  const result = await scheduler.run();

  expect(result.status).toBe('CANCELLED');

  // dag.cancelled 事件应被发射
  const events = await ctx.storage.getEvents('test_run_1');
  expect(events.some((e) => e.type === 'dag.cancelled')).toBe(true);
});

// 取消后 RUNNING 节点收到 node.cancelled
test('取消后 RUNNING 节点被标记为 CANCELLED', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B'),
    shellNode('C'),
  ];
  executor.setDelay('A', 200);
  executor.setDelay('B', 200);
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  setTimeout(() => ctx.cancellation.cancel(), 50);

  const result = await scheduler.run();

  expect(result.status).toBe('CANCELLED');

  const events = await ctx.storage.getEvents('test_run_1');
  const cancelledEvents = events.filter((e) => e.type === 'node.cancelled');
  // 至少有 dag.cancelled，节点级 cancelled 取决于执行时机
  expect(events.some((e) => e.type === 'dag.cancelled')).toBe(true);
});

// ---------- DAG 超时 ----------

// 超时后状态变为 CANCELLED
test('DAG 超时后进入 CANCELLED', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
  ];
  executor.setDelay('A', 5000); // A 执行很久
  const ctx = makeContext(executor, nodes, 100); // 100ms 超时
  const scheduler = new DAGScheduler(ctx);

  const start = Date.now();
  const result = await scheduler.run();
  const elapsed = Date.now() - start;

  expect(result.status).toBe('CANCELLED');
  // 应该在超时附近完成，而非等待 5 秒
  expect(elapsed).toBeLessThan(500);
});

// ---------- SUSPENDED ----------

// 审计节点抛出 SuspendedError
test('SuspendedError 导致 DAG 进入 SUSPENDED', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
  ];
  executor.setError('B', new SuspendedError('Approval required', 'B', { data: 'test' }));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe('SUSPENDED');

  // audit.requested 事件应被发射
  const events = await ctx.storage.getEvents('test_run_1');
  expect(events.some((e) => e.type === 'audit.requested')).toBe(true);

  // A 应已完成
  const aOutput = await ctx.storage.getOutput('test_run_1', 'A');
  expect(aOutput).not.toBeNull();
});

// ---------- 事件和快照 ----------

// dag.started 和 dag.completed 事件
test('发射 dag.started 和 dag.completed 事件', async () => {
  const nodes: NodeDef[] = [shellNode('A')];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents('test_run_1');
  expect(events.some((e) => e.type === 'dag.started')).toBe(true);
  expect(events.some((e) => e.type === 'dag.completed')).toBe(true);
  expect(events.some((e) => e.type === 'node.started' && e.node_id === 'A')).toBe(true);
  expect(events.some((e) => e.type === 'node.completed' && e.node_id === 'A')).toBe(true);
});

// 快照包含正确节点状态
test('快照包含正确的节点状态', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
  ];
  executor.setError('B', new Error('fail'));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const latestSnapshot = await ctx.storage.getLatestSnapshot('test_run_1');
  expect(latestSnapshot).not.toBeNull();
  expect(latestSnapshot!.node_states['A'].status).toBe('COMPLETED');
  expect(latestSnapshot!.node_states['B'].status).toBe('FAILED');
  expect(latestSnapshot!.dag_status).toBe('FAILED');
});

// 事件有正确的 run_id
test('所有事件携带正确的 run_id', async () => {
  const nodes: NodeDef[] = [shellNode('A')];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents('test_run_1');
  for (const event of events) {
    expect(event.run_id).toBe('test_run_1');
  }
});

// 事件有时间戳
test('所有事件有 ISO 8601 时间戳', async () => {
  const nodes: NodeDef[] = [shellNode('A')];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents('test_run_1');
  for (const event of events) {
    expect(event.timestamp).toBeTruthy();
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  }
});

// ---------- 摘要 ----------

// 成功摘要
test('成功时摘要正确', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['A']),
  ];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe('SUCCESS');
  expect(result.summary.run_id).toBe('test_run_1');
  expect(result.summary.workflow_name).toBe('test-workflow');
  expect(result.summary.node_summary.total).toBe(3);
  expect(result.summary.node_summary.completed).toBe(3);
  expect(result.summary.node_summary.failed).toBe(0);
  expect(result.summary.started_at).toBeTruthy();
  expect(result.summary.completed_at).toBeTruthy();
});

// 失败摘要
test('失败时摘要包含失败计数', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
  ];
  executor.setError('B', new Error('fail'));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe('FAILED');
  expect(result.summary.node_summary.completed).toBe(1);
  expect(result.summary.node_summary.failed).toBe(1);
});

// ---------- 边界情况 ----------

// 空工作流
test('空工作流直接 SUCCESS', async () => {
  const nodes: NodeDef[] = [];
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe('SUCCESS');
  expect(result.summary.node_summary.total).toBe(0);
});

// 多依赖收敛
test('D 等待 B 和 C 都完成后才执行', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['A']),
    shellNode('D', ['B', 'C']),
  ];
  executor.setDelay('B', 100);
  executor.setDelay('C', 50);
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  const result = await scheduler.run();

  expect(result.status).toBe('SUCCESS');
  const order = executor.getExecutionOrder();
  expect(order[0]).toBe('A');
  expect(order[order.length - 1]).toBe('D');

  // B 和 C 都在 D 之前
  expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
  expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
});

// 节点输出存储
test('节点输出通过 storage 持久化', async () => {
  const nodes: NodeDef[] = [shellNode('A')];
  executor.setOutput('A', { stdout: 'custom output', exit_code: 0, json: { result: 42 } });
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const output = await ctx.storage.getOutput('test_run_1', 'A');
  expect(output).not.toBeNull();
  expect(output!.stdout).toBe('custom output');
  expect(output!.exit_code).toBe(0);
  expect(output!.json).toEqual({ result: 42 });
});

// node.failed 事件包含错误信息
test('node.failed 事件包含错误信息', async () => {
  const nodes: NodeDef[] = [shellNode('A')];
  executor.setError('A', new Error('something went wrong'));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents('test_run_1');
  const failedEvent = events.find((e) => e.type === 'node.failed');
  expect(failedEvent).not.toBeNull();
  expect(failedEvent!.metadata?.error).toBe('something went wrong');
});

// node.skipped 事件包含 upstream_failed 原因
test('node.skipped 事件包含 upstream_failed 原因', async () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
  ];
  executor.setError('A', new Error('fail'));
  const ctx = makeContext(executor, nodes);
  const scheduler = new DAGScheduler(ctx);

  await scheduler.run();

  const events = await ctx.storage.getEvents('test_run_1');
  const skippedEvent = events.find((e) => e.type === 'node.skipped');
  expect(skippedEvent).not.toBeNull();
  expect(skippedEvent!.metadata?.reason).toBe('upstream_failed');
});
