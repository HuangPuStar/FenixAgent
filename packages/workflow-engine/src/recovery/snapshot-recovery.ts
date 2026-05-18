/**
 * DAG 崩溃恢复 — 基于快照重放恢复执行。
 *
 * 恢复流程：
 * 1. 加载最新快照 + 重放后续事件，重建完整节点状态
 * 2. 检测孤儿节点（有 started 无 completed/failed/cancelled）
 * 3. 清理孤儿节点（终止残留进程、标记状态）
 * 4. 使用恢复的状态重新调度执行
 */

import { nanoid } from 'nanoid';
import type { NodeDef, WorkflowDef } from '../types/dag';
import type { DAGEvent, DAGSnapshot, DAGStatus, NodeOutput, NodeStatus } from '../types/execution';
import type { StorageAdapter } from '../storage/storage-adapter';
import { DAGScheduler } from '../scheduler/dag-scheduler';
import type { SchedulerContext } from '../scheduler/dag-scheduler';
import { CancellationManager } from '../scheduler/cancellation';
import { WorkflowError, WorkflowErrorCode } from '../types/errors';

// ---------- 导出类型 ----------

/** 恢复结果 */
export interface RecoveryResult {
  runId: string;
  status: DAGStatus;
  summary: import('../types/execution').RunSummary;
}

// ---------- 内部类型 ----------

/** 重放后重建的完整状态 */
interface ReplayedState {
  nodeStates: Map<string, NodeStatus>;
  nodeOutputs: Map<string, NodeOutput>;
  dagStatus: DAGStatus;
  lastEventId: string;
}

/** 孤儿节点信息 */
interface OrphanNode {
  nodeId: string;
  nodeType: string;
  pid?: number;
}

// ---------- 主函数 ----------

/**
 * 从快照恢复 DAG 执行。
 *
 * 幂等：多次调用安全。已完成的 DAG 直接返回 SUCCESS。
 */
export async function recoverRun(context: SchedulerContext): Promise<RecoveryResult> {
  const { runId, storage, workflowDef } = context;

  // Step 1: 加载快照 + 重放事件
  const snapshot = await storage.getLatestSnapshot(runId);
  if (!snapshot) {
    throw new WorkflowError(
      `No snapshot found for run ${runId}`,
      WorkflowErrorCode.RECOVERY_ERROR,
      { runId },
    );
  }

  const state = await replayEvents(snapshot, storage);

  // 已完成的 DAG 直接返回
  if (state.dagStatus === 'SUCCESS' || state.dagStatus === 'FAILED' || state.dagStatus === 'CANCELLED') {
    return buildTerminalResult(runId, workflowDef, state);
  }

  // SUSPENDED 状态：检查是否有待审批节点，如果有则等待 approve
  if (state.dagStatus === 'SUSPENDED') {
    // SUSPENDED 的恢复意味着调度器应继续等待审批
    // 将 SUSPENDED 节点保持原状，其他节点交给调度器处理
    const recoveryContext = buildRecoveryContext(context, state);
    const scheduler = new DAGScheduler(recoveryContext);
    return scheduler.run();
  }

  // Step 2: 检测孤儿节点
  const orphans = await detectOrphans(runId, storage, snapshot.last_event_id, workflowDef);

  // Step 3: 清理孤儿节点
  const cleanupState = await cleanupOrphans(orphans, state, storage, runId, workflowDef);

  // Step 4: 重新调度
  const recoveryContext = buildRecoveryContext(context, cleanupState);
  const scheduler = new DAGScheduler(recoveryContext);
  return scheduler.run();
}

// ---------- Step 1: 快照 + 重放 ----------

/**
 * 从快照出发，重放 last_event_id 之后的事件，重建完整节点状态。
 */
async function replayEvents(
  snapshot: DAGSnapshot,
  storage: StorageAdapter,
): Promise<ReplayedState> {
  const nodeStates = new Map<string, NodeStatus>();
  const nodeOutputs = new Map<string, NodeOutput>();

  // 从快照恢复已有状态
  for (const [id, state] of Object.entries(snapshot.node_states)) {
    nodeStates.set(id, state.status);
  }

  // 获取快照之后的所有事件
  const events = await storage.getEvents(snapshot.run_id, {
    afterEventId: snapshot.last_event_id,
  });

  // 重放事件，逐步更新状态
  for (const event of events) {
    if (!event.node_id) continue;

    switch (event.type) {
      case 'node.completed':
        nodeStates.set(event.node_id, 'COMPLETED');
        break;
      case 'node.failed':
        nodeStates.set(event.node_id, 'FAILED');
        break;
      case 'node.cancelled':
        nodeStates.set(event.node_id, 'CANCELLED');
        break;
      case 'node.skipped':
        nodeStates.set(event.node_id, 'SKIPPED');
        break;
      case 'audit.requested':
        nodeStates.set(event.node_id, 'SUSPENDED' as NodeStatus);
        break;
      case 'audit.approved':
        nodeStates.set(event.node_id, 'COMPLETED');
        break;
      case 'node.started':
        nodeStates.set(event.node_id, 'RUNNING');
        break;
    }
  }

  // 加载已完成节点的输出
  for (const [id, status] of nodeStates) {
    if (status === 'COMPLETED') {
      const output = await storage.getOutput(snapshot.run_id, id);
      if (output) {
        nodeOutputs.set(id, output);
      }
    }
  }

  // 确定最新的 lastEventId
  const lastEventId = events.length > 0
    ? events[events.length - 1].event_id
    : snapshot.last_event_id;

  return {
    nodeStates,
    nodeOutputs,
    dagStatus: snapshot.dag_status,
    lastEventId,
  };
}

// ---------- Step 2: 孤儿检测 ----------

/**
 * 检测孤儿节点：有 node.started 但没有 node.completed/failed/cancelled/skipped 的节点。
 */
async function detectOrphans(
  runId: string,
  storage: StorageAdapter,
  afterEventId: string,
  workflowDef: WorkflowDef,
): Promise<OrphanNode[]> {
  // 获取所有事件
  const allEvents = await storage.getEvents(runId, {
    afterEventId: undefined,
  });

  const startedNodes = new Map<string, { nodeType?: string; pid?: number }>();
  const completedNodes = new Set<string>();

  // 扫描所有事件
  for (const event of allEvents) {
    if (!event.node_id) continue;

    if (event.type === 'node.started') {
      startedNodes.set(event.node_id, {
        nodeType: event.node_type,
        pid: event.metadata?.pid as number | undefined,
      });
    }

    if (
      event.type === 'node.completed' ||
      event.type === 'node.failed' ||
      event.type === 'node.cancelled' ||
      event.type === 'node.skipped' ||
      event.type === 'audit.requested'
    ) {
      completedNodes.add(event.node_id);
    }
  }

  // 孤儿 = started 但未 completed/failed/cancelled/skipped
  const orphans: OrphanNode[] = [];
  for (const [nodeId, info] of startedNodes) {
    if (!completedNodes.has(nodeId)) {
      const nodeDef = workflowDef.nodes.find((n) => n.id === nodeId);
      orphans.push({
        nodeId,
        nodeType: info.nodeType ?? nodeDef?.type ?? 'unknown',
        pid: info.pid,
      });
    }
  }

  return orphans;
}

// ---------- Step 3: 孤儿清理 ----------

/**
 * 清理孤儿节点：终止残留进程，标记状态，决定是否重试。
 */
async function cleanupOrphans(
  orphans: OrphanNode[],
  state: ReplayedState,
  storage: StorageAdapter,
  runId: string,
  workflowDef: WorkflowDef,
): Promise<ReplayedState> {
  const updatedStates = new Map(state.nodeStates);
  const updatedOutputs = new Map(state.nodeOutputs);

  for (const orphan of orphans) {
    const nodeDef = workflowDef.nodes.find((n) => n.id === orphan.nodeId);

    switch (orphan.nodeType) {
      case 'shell': {
        // Shell 节点：尝试终止残留进程
        await cleanupShellOrphan(orphan, storage, runId);
        updatedStates.set(orphan.nodeId, 'CANCELLED');
        break;
      }
      case 'agent': {
        // Agent 节点：无法可靠检测远程 agent，直接取消
        await emitCleanupEvent(storage, runId, orphan.nodeId, orphan.nodeType, 'node.cancelled');
        updatedStates.set(orphan.nodeId, 'CANCELLED');
        break;
      }
      case 'loop': {
        // LoopNode 崩溃恢复：MVP 行为，标记 ERROR
        await emitCleanupEvent(storage, runId, orphan.nodeId, orphan.nodeType, 'node.failed', {
          error: 'recovery_not_supported',
        });
        updatedStates.set(orphan.nodeId, 'FAILED');
        break;
      }
      case 'workflow': {
        // SubWorkflowNode 崩溃恢复：MVP 行为，标记 ERROR
        await emitCleanupEvent(storage, runId, orphan.nodeId, orphan.nodeType, 'node.failed', {
          error: 'recovery_not_supported',
        });
        updatedStates.set(orphan.nodeId, 'FAILED');
        break;
      }
      default: {
        // 其他类型：取消
        await emitCleanupEvent(storage, runId, orphan.nodeId, orphan.nodeType, 'node.cancelled');
        updatedStates.set(orphan.nodeId, 'CANCELLED');
        break;
      }
    }

    // 检查重试配置
    const retryConfig = nodeDef?.retry;
    if (retryConfig && retryConfig.count > 0 && updatedStates.get(orphan.nodeId) !== 'FAILED') {
      // 有重试机会且不是 MVP 限制的失败 → 标记为 PENDING 让调度器重试
      updatedStates.set(orphan.nodeId, 'PENDING');
    }
  }

  return {
    nodeStates: updatedStates,
    nodeOutputs: updatedOutputs,
    dagStatus: state.dagStatus,
    lastEventId: state.lastEventId,
  };
}

/**
 * 清理 Shell 孤儿节点：尝试终止残留进程。
 */
async function cleanupShellOrphan(
  orphan: OrphanNode,
  storage: StorageAdapter,
  runId: string,
): Promise<void> {
  if (orphan.pid == null) {
    // 没有 PID，无法终止，直接取消
    await emitCleanupEvent(storage, runId, orphan.nodeId, orphan.nodeType, 'node.cancelled');
    return;
  }

  const pid = orphan.pid;

  // 检查进程是否存活
  try {
    process.kill(pid, 0);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // 进程已死，无需操作
      await emitCleanupEvent(storage, runId, orphan.nodeId, orphan.nodeType, 'node.cancelled');
      return;
    }
    // EPERM 或其他错误 → 保守处理，视为存活
  }

  // 进程存活 → SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // kill 失败，进程可能已退出
    await emitCleanupEvent(storage, runId, orphan.nodeId, orphan.nodeType, 'node.cancelled');
    return;
  }

  // 等待 5 秒宽限期
  await Bun.sleep(5000);

  // 检查是否已退出
  try {
    process.kill(pid, 0);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // 已退出
      await emitCleanupEvent(storage, runId, orphan.nodeId, orphan.nodeType, 'node.cancelled');
      return;
    }
  }

  // 仍存活 → SIGKILL
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 忽略，可能刚好退出
  }

  await emitCleanupEvent(storage, runId, orphan.nodeId, orphan.nodeType, 'node.cancelled');
}

// ---------- 辅助函数 ----------

/** 发射清理事件（cancelled 或 failed） */
async function emitCleanupEvent(
  storage: StorageAdapter,
  runId: string,
  nodeId: string,
  nodeType: string,
  type: 'node.cancelled' | 'node.failed',
  metadata?: Record<string, unknown>,
): Promise<void> {
  const event: DAGEvent = {
    event_id: `evt_${nanoid(10)}`,
    run_id: runId,
    timestamp: new Date().toISOString(),
    type,
    node_id: nodeId,
    node_type: nodeType as DAGEvent['node_type'],
    ...(metadata ? { metadata } : {}),
  };
  await storage.appendEvent(event);
}

/** 构建恢复用的调度上下文（注入初始状态） */
function buildRecoveryContext(
  original: SchedulerContext,
  state: ReplayedState,
): SchedulerContext {
  return {
    ...original,
    cancellation: new CancellationManager(),
    initialNodeStates: state.nodeStates,
    initialNodeOutputs: state.nodeOutputs,
  };
}

/** 为已终止的 DAG 构建结果 */
function buildTerminalResult(
  runId: string,
  workflowDef: WorkflowDef,
  state: ReplayedState,
): RecoveryResult {
  let completed = 0;
  let failed = 0;
  let running = 0;

  for (const s of state.nodeStates.values()) {
    if (s === 'COMPLETED') completed++;
    else if (s === 'FAILED') failed++;
    else if (s === 'RUNNING') running++;
  }

  return {
    runId,
    status: state.dagStatus,
    summary: {
      run_id: runId,
      workflow_name: workflowDef.name,
      status: state.dagStatus,
      started_at: '',
      completed_at: new Date().toISOString(),
      node_summary: {
        total: workflowDef.nodes.length,
        completed,
        failed,
        running,
      },
    },
  };
}
