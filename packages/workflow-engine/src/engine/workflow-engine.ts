/**
 * 工作流引擎门面 — 唯一公开 API 入口，整合所有组件。
 *
 * createWorkflowEngine() 创建引擎实例，提供 parse / validate / run / dryRun /
 * cancel / approveNode / getRunStatus / getOutput / getEvents / getPendingApprovals / recover
 * 等完整生命周期管理。
 */

import { nanoid } from "nanoid";
import { AgentExecutor } from "../executor/agent-executor";
import { ApiExecutor } from "../executor/api-executor";
import type { PendingApproval } from "../executor/awaitable-executor";
import { AuditExecutor, verifyApprovalToken } from "../executor/awaitable-executor";
import { LoopExecutor } from "../executor/loop-executor";
import { NodeExecutorRegistry } from "../executor/node-executor";
import { ProcessExecutor } from "../executor/process-executor";
import { PythonExecutor } from "../executor/python-executor";
import { SubWorkflowExecutor } from "../executor/sub-workflow-executor";
import type { ValidationIssue, ValidationResult } from "../parser/dag-validator";
import { validateDAG } from "../parser/dag-validator";
import { parseWorkflowYaml } from "../parser/yaml-parser";
import { recoverRun } from "../recovery/snapshot-recovery";
import { CancellationManager } from "../scheduler/cancellation";
import type { DAGRunResult, SchedulerContext } from "../scheduler/dag-scheduler";
import { DAGScheduler } from "../scheduler/dag-scheduler";
import { identifyParallelGroups, topologicalSort } from "../scheduler/topological-sort";
import { SecretsResolver } from "../secrets/secrets-resolver";
import type { StorageAdapter } from "../storage/storage-adapter";
import type { Transport } from "../transport/transport";
import type { WorkflowDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { DAGEvent, DAGSnapshot, NodeOutput } from "../types/execution";

// ---------- 公开类型 ----------

/** createWorkflowEngine 构造选项 */
export interface WorkflowEngineOptions {
  storage: StorageAdapter;
  transport?: Transport;
  /** AuditNode HMAC 签名密钥 */
  hmacSecret: string;
  /** .env 文件路径 */
  envFile?: string;
  /** 默认工作目录（子流程 ref 解析基准） */
  defaultCwd?: string;
}

/** dryRun 结果 */
export interface DryRunResult {
  valid: boolean;
  issues: ValidationIssue[];
  executionPlan: {
    topologicalOrder: string[];
    parallelGroups: string[][];
  };
}

/** 工作流引擎实例 */
export interface WorkflowEngine {
  /** 解析 YAML 为 WorkflowDef */
  parse(yaml: string, baseDir?: string): WorkflowDef;

  /** 校验 WorkflowDef */
  validate(def: WorkflowDef): ValidationResult;

  /** 执行工作流（阻塞，返回最终结果） */
  run(yaml: string, params?: Record<string, unknown>): Promise<DAGRunResult>;

  /** 异步启动工作流，立即返回 runId 和结果 Promise */
  runAsync(yaml: string, params?: Record<string, unknown>): { runId: string; result: Promise<DAGRunResult> };

  /** 干运行 — 校验 + 展示执行计划，不实际执行 */
  dryRun(yaml: string): DryRunResult;

  /** 取消运行 */
  cancel(runId: string): Promise<void>;

  /** 审批节点通过 */
  approveNode(runId: string, nodeId: string, token: string, data?: unknown): Promise<void>;

  /** 获取运行状态快照 */
  getRunStatus(runId: string): Promise<DAGSnapshot | null>;

  /** 获取节点输出 */
  getOutput(runId: string, nodeId: string): Promise<NodeOutput | null>;

  /** 获取事件流 */
  getEvents(runId: string, opts?: { nodeId?: string }): Promise<DAGEvent[]>;

  /** 获取待审批列表 */
  getPendingApprovals(runId: string): Promise<PendingApproval[]>;

  /** 从快照恢复运行 */
  recover(runId: string, yaml: string): Promise<DAGRunResult>;

  /** 从指定节点重新运行（保留上游输出，目标节点及下游重新执行） */
  rerunFrom(prevRunId: string, yaml: string, fromNodeId: string): Promise<DAGRunResult>;
}

// ---------- 活跃运行记录 ----------

interface ActiveRun {
  cancellation: CancellationManager;
  workflowDef: WorkflowDef;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
}

// ---------- createWorkflowEngine ----------

/**
 * 创建工作流引擎实例。
 *
 * 内部为每次 run 构建独立的 NodeExecutorRegistry（因为 SubWorkflowExecutor /
 * LoopExecutor 需要 per-run 的 parentRunId）。
 */
export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const { storage, transport, hmacSecret, envFile, defaultCwd } = options;

  const secretsResolver = new SecretsResolver({ envFile });

  // 活跃运行记录：runId → { cancellation, workflowDef }
  const activeRuns = new Map<string, ActiveRun>();

  // ---------- 内部：构建 per-run 执行器注册表 ----------

  function buildRegistry(runId: string, baseDir: string): NodeExecutorRegistry {
    const registry = new NodeExecutorRegistry();
    registry.register("shell", new ProcessExecutor());
    registry.register("python", new PythonExecutor());
    registry.register("api", new ApiExecutor());
    if (transport) {
      registry.register("agent", new AgentExecutor(transport));
    }
    registry.register("audit", new AuditExecutor(hmacSecret));
    registry.register("workflow", new SubWorkflowExecutor(runId, registry, baseDir));
    registry.register("loop", new LoopExecutor(runId, registry));
    return registry;
  }

  // ---------- 公开 API 实现 ----------

  function parse(yaml: string, baseDir?: string): WorkflowDef {
    return parseWorkflowYaml(yaml, baseDir);
  }

  function validate(def: WorkflowDef): ValidationResult {
    return validateDAG(def);
  }

  async function run(yaml: string, params: Record<string, unknown> = {}): Promise<DAGRunResult> {
    const { runId, context } = await prepareRun(yaml, params);

    let result: DAGRunResult | undefined;
    try {
      const scheduler = new DAGScheduler(context);
      result = await scheduler.run();
      return result;
    } finally {
      if (result?.status !== "SUSPENDED") {
        activeRuns.delete(runId);
      }
    }
  }

  function runAsync(
    yaml: string,
    params: Record<string, unknown> = {},
  ): { runId: string; result: Promise<DAGRunResult> } {
    const runId = `run_${nanoid(10)}`;

    // 同步：解析 + 校验（失败直接抛）
    const def = parse(yaml, defaultCwd);
    const validation = validate(def);
    if (!validation.valid) {
      const errors = validation.issues
        .filter((i) => i.type === "error")
        .map((i) => i.message)
        .join("; ");
      throw new WorkflowError(`Workflow validation failed: ${errors}`, WorkflowErrorCode.VALIDATION_ERROR, {
        issues: validation.issues,
      });
    }

    const resolvedParams = { ...params };
    if (validation.def.params) {
      for (const [key, schema] of Object.entries(validation.def.params)) {
        if (!(key in resolvedParams) && schema.default !== undefined) {
          resolvedParams[key] = schema.default;
        }
      }
    }

    // 后台执行，返回 Promise 供调用方订阅完成事件
    const resultPromise = (async (): Promise<DAGRunResult> => {
      let secrets: Record<string, string> = {};
      if (def.secrets && def.secrets.length > 0) {
        secrets = await secretsResolver.resolve(def.secrets);
      }

      const cancellation = new CancellationManager();
      const baseDir = defaultCwd ?? process.cwd();
      const registry = buildRegistry(runId, baseDir);

      const context: SchedulerContext = {
        runId,
        workflowDef: validation.def,
        storage,
        params: resolvedParams,
        secrets,
        nodeExecutor: registry,
        cancellation,
        spawnedEnvIds: new Set<string>(),
      };

      activeRuns.set(runId, { cancellation, workflowDef: validation.def, params: resolvedParams, secrets });

      let result: DAGRunResult | undefined;
      try {
        const scheduler = new DAGScheduler(context);
        result = await scheduler.run();
        return result;
      } catch (err) {
        console.error(`[workflow-engine] runAsync ${runId} failed:`, err);
        throw err;
      } finally {
        if (result?.status !== "SUSPENDED") {
          activeRuns.delete(runId);
        }
      }
    })();

    return { runId, result: resultPromise };
  }

  async function prepareRun(
    yaml: string,
    params: Record<string, unknown> = {},
  ): Promise<{ runId: string; context: SchedulerContext }> {
    const def = parse(yaml, defaultCwd);
    const validation = validate(def);
    if (!validation.valid) {
      const errors = validation.issues
        .filter((i) => i.type === "error")
        .map((i) => i.message)
        .join("; ");
      throw new WorkflowError(`Workflow validation failed: ${errors}`, WorkflowErrorCode.VALIDATION_ERROR, {
        issues: validation.issues,
      });
    }

    const runId = `run_${nanoid(10)}`;

    const resolvedParams = { ...params };
    if (validation.def.params) {
      for (const [key, schema] of Object.entries(validation.def.params)) {
        if (!(key in resolvedParams) && schema.default !== undefined) {
          resolvedParams[key] = schema.default;
        }
      }
    }

    let secrets: Record<string, string> = {};
    if (def.secrets && def.secrets.length > 0) {
      secrets = await secretsResolver.resolve(def.secrets);
    }

    const cancellation = new CancellationManager();
    const baseDir = defaultCwd ?? process.cwd();
    const registry = buildRegistry(runId, baseDir);

    const context: SchedulerContext = {
      runId,
      workflowDef: validation.def,
      storage,
      params: resolvedParams,
      secrets,
      nodeExecutor: registry,
      cancellation,
      spawnedEnvIds: new Set<string>(),
    };

    activeRuns.set(runId, { cancellation, workflowDef: validation.def, params: resolvedParams, secrets });

    return { runId, context };
  }

  function dryRun(yaml: string): DryRunResult {
    const def = parse(yaml, defaultCwd);
    const validation = validate(def);

    // topologicalSort 和 identifyParallelGroups 使用 validation.def（增强后的）
    let topologicalOrder: string[] = [];
    let parallelGroups: string[][] = [];

    if (validation.valid) {
      topologicalOrder = topologicalSort(validation.def.nodes);
      parallelGroups = identifyParallelGroups(validation.def.nodes);
    }

    return {
      valid: validation.valid,
      issues: validation.issues,
      executionPlan: { topologicalOrder, parallelGroups },
    };
  }

  async function cancel(runId: string): Promise<void> {
    const activeRun = activeRuns.get(runId);
    if (!activeRun) {
      throw new WorkflowError(`Run '${runId}' not found or already completed`, WorkflowErrorCode.RUN_NOT_FOUND, {
        runId,
      });
    }
    activeRun.cancellation.cancel();
  }

  async function approveNode(runId: string, nodeId: string, token: string, data?: unknown): Promise<void> {
    // 1. 验证 token
    const { valid, expired } = verifyApprovalToken(token, runId, nodeId, hmacSecret);
    if (!valid) {
      if (expired) {
        throw new WorkflowError("Approval token has expired", WorkflowErrorCode.VALIDATION_ERROR, { runId, nodeId });
      }
      throw new WorkflowError("Invalid approval token", WorkflowErrorCode.VALIDATION_ERROR, { runId, nodeId });
    }

    // 2. 查找活跃运行
    const activeRun = activeRuns.get(runId);
    if (!activeRun) {
      // 非活跃运行：尝试通过 recover 恢复
      await recoverFromApproval(runId, nodeId, data);
      return;
    }

    // 3. 活跃运行：发射 audit.approved 事件并重新调度
    // 重新创建 DAGScheduler 继续执行（SUSPENDED 状态的恢复）
    const baseDir = defaultCwd ?? process.cwd();
    const registry = buildRegistry(runId, baseDir);

    // 从 storage 获取最新快照重建状态
    const snapshot = await storage.getLatestSnapshot(runId);
    if (!snapshot) {
      throw new WorkflowError(`No snapshot found for run ${runId}`, WorkflowErrorCode.RECOVERY_ERROR, { runId });
    }

    // 重建节点状态
    const nodeStates = new Map<string, import("../types/execution").NodeStatus>();
    const nodeOutputs = new Map<string, NodeOutput>();
    for (const [id, state] of Object.entries(snapshot.node_states)) {
      nodeStates.set(id, state.status);
      if (state.status === "COMPLETED") {
        const output = await storage.getOutput(runId, id);
        if (output) nodeOutputs.set(id, output);
      }
    }

    // 将审批节点标记为 COMPLETED
    nodeStates.set(nodeId, "COMPLETED");
    if (data !== undefined) {
      nodeOutputs.set(nodeId, {
        stdout: typeof data === "string" ? data : JSON.stringify(data),
        json: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : { approved: data },
        exit_code: 0,
      });
    }

    // 发射 audit.approved 事件
    const approvedEvent: DAGEvent = {
      event_id: `evt_${nanoid(10)}`,
      run_id: runId,
      timestamp: new Date().toISOString(),
      type: "audit.approved",
      node_id: nodeId,
      node_type: "audit",
      metadata: data !== undefined ? { data } : {},
    };
    await storage.appendEvent(approvedEvent);

    // 用恢复上下文重新调度
    const context: SchedulerContext = {
      runId,
      workflowDef: activeRun.workflowDef,
      storage,
      params: activeRun.params,
      secrets: activeRun.secrets,
      nodeExecutor: registry,
      cancellation: activeRun.cancellation,
      initialNodeStates: nodeStates,
      initialNodeOutputs: nodeOutputs,
      spawnedEnvIds: new Set<string>(),
    };

    const scheduler = new DAGScheduler(context);
    const result = await scheduler.run();

    // 恢复执行后，若非再次 SUSPENDED 则清理活跃记录
    if (result.status !== "SUSPENDED") {
      activeRuns.delete(runId);
    }
  }

  /** 非活跃运行的审批恢复 */
  async function recoverFromApproval(runId: string, nodeId: string, data?: unknown): Promise<void> {
    const snapshot = await storage.getLatestSnapshot(runId);
    if (!snapshot) {
      throw new WorkflowError(`No snapshot found for run ${runId}`, WorkflowErrorCode.RECOVERY_ERROR, { runId });
    }

    // 发射 audit.approved 事件
    const approvedEvent: DAGEvent = {
      event_id: `evt_${nanoid(10)}`,
      run_id: runId,
      timestamp: new Date().toISOString(),
      type: "audit.approved",
      node_id: nodeId,
      node_type: "audit",
      metadata: data !== undefined ? { data } : {},
    };
    await storage.appendEvent(approvedEvent);

    // 重建状态并标记审批节点为 COMPLETED
    const nodeStates = new Map<string, import("../types/execution").NodeStatus>();
    const nodeOutputs = new Map<string, NodeOutput>();
    for (const [id, state] of Object.entries(snapshot.node_states)) {
      nodeStates.set(id, state.status);
      if (state.status === "COMPLETED") {
        const output = await storage.getOutput(runId, id);
        if (output) nodeOutputs.set(id, output);
      }
    }
    nodeStates.set(nodeId, "COMPLETED");
    if (data !== undefined) {
      nodeOutputs.set(nodeId, {
        stdout: typeof data === "string" ? data : JSON.stringify(data),
        json: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : { approved: data },
        exit_code: 0,
      });
    }

    // 需要 WorkflowDef 才能恢复 — 从 snapshot 的 node_states 推断不完整
    // 这里抛出提示用户使用 recover()
    throw new WorkflowError(
      `Run '${runId}' is not active. Use recover() to resume from snapshot with the workflow YAML.`,
      WorkflowErrorCode.RECOVERY_ERROR,
      { runId, nodeId },
    );
  }

  async function getRunStatus(runId: string): Promise<DAGSnapshot | null> {
    return storage.getLatestSnapshot(runId);
  }

  async function getOutput(runId: string, nodeId: string): Promise<NodeOutput | null> {
    return storage.getOutput(runId, nodeId);
  }

  async function getEvents(runId: string, opts?: { nodeId?: string }): Promise<DAGEvent[]> {
    return storage.getEvents(runId, { nodeId: opts?.nodeId });
  }

  async function getPendingApprovals(runId: string): Promise<PendingApproval[]> {
    const events = await storage.getEvents(runId);
    const approvedNodeIds = new Set<string>();

    // 先收集所有已审批的节点 ID
    for (const event of events) {
      if (event.type === "audit.approved" && event.node_id) {
        approvedNodeIds.add(event.node_id);
      }
    }

    // 收集所有待审批请求（排除已审批的）
    const pending: PendingApproval[] = [];
    for (const event of events) {
      if (event.type === "audit.requested" && event.node_id && !approvedNodeIds.has(event.node_id)) {
        const metadata = event.metadata ?? {};
        const displayData = metadata.display_data as Record<string, unknown> | undefined;
        pending.push({
          runId,
          nodeId: event.node_id,
          approvalToken: (displayData?.approvalToken as string) ?? "",
          expiresAt: (displayData?.expiresAt as string) ?? "",
          displayData: displayData?.display_data,
        });
      }
    }

    return pending;
  }

  async function recover(runId: string, yaml: string): Promise<DAGRunResult> {
    const def = parse(yaml, defaultCwd);
    const validation = validate(def);
    if (!validation.valid) {
      const errors = validation.issues
        .filter((i) => i.type === "error")
        .map((i) => i.message)
        .join("; ");
      throw new WorkflowError(`Workflow validation failed: ${errors}`, WorkflowErrorCode.VALIDATION_ERROR, {
        issues: validation.issues,
      });
    }

    // 从 dag.started 事件中恢复 params
    let recoveredParams: Record<string, unknown> = {};
    try {
      const startEvents = await storage.getEvents(runId, { types: ["dag.started"] });
      const paramsFromEvent = startEvents[0]?.metadata?.params;
      if (paramsFromEvent && typeof paramsFromEvent === "object") {
        recoveredParams = paramsFromEvent as Record<string, unknown>;
      }
    } catch {
      // 事件读取失败时不阻塞 recover
    }

    // 合并 params：先填充 YAML 中定义的默认值，再覆盖恢复的 params
    const resolvedParams: Record<string, unknown> = { ...recoveredParams };
    if (validation.def.params) {
      for (const [key, schema] of Object.entries(validation.def.params)) {
        if (!(key in resolvedParams) && schema.default !== undefined) {
          resolvedParams[key] = schema.default;
        }
      }
    }

    // Secrets 解析
    let secrets: Record<string, string> = {};
    if (validation.def.secrets && validation.def.secrets.length > 0) {
      secrets = await secretsResolver.resolve(validation.def.secrets);
    }

    const baseDir = defaultCwd ?? process.cwd();
    const registry = buildRegistry(runId, baseDir);
    const cancellation = new CancellationManager();

    // 存储为活跃运行
    activeRuns.set(runId, { cancellation, workflowDef: validation.def, params: resolvedParams, secrets });

    let result: DAGRunResult | undefined;
    try {
      const context: SchedulerContext = {
        runId,
        workflowDef: validation.def,
        storage,
        params: resolvedParams,
        secrets,
        nodeExecutor: registry,
        cancellation,
        spawnedEnvIds: new Set<string>(),
      };

      result = await recoverRun(context);
      return result;
    } finally {
      // SUSPENDED 状态保留 activeRun，等待 approveNode 恢复
      if (result?.status !== "SUSPENDED") {
        activeRuns.delete(runId);
      }
    }
  }

  async function rerunFrom(prevRunId: string, yaml: string, fromNodeId: string): Promise<DAGRunResult> {
    const def = parse(yaml, defaultCwd);
    const validation = validate(def);
    if (!validation.valid) {
      const errors = validation.issues
        .filter((i) => i.type === "error")
        .map((i) => i.message)
        .join("; ");
      throw new WorkflowError(`Workflow validation failed: ${errors}`, WorkflowErrorCode.VALIDATION_ERROR, {
        issues: validation.issues,
      });
    }

    // 获取上一次运行的快照
    const snapshot = await storage.getLatestSnapshot(prevRunId);
    if (!snapshot) {
      throw new WorkflowError(`No snapshot found for run ${prevRunId}`, WorkflowErrorCode.RECOVERY_ERROR, {
        runId: prevRunId,
      });
    }

    // BFS 找 fromNodeId 的所有下游节点
    const reverseAdj = new Map<string, string[]>();
    for (const n of validation.def.nodes) {
      for (const dep of n.depends_on ?? []) {
        const list = reverseAdj.get(dep) ?? [];
        list.push(n.id);
        reverseAdj.set(dep, list);
      }
    }
    const downstream = new Set<string>();
    const queue = [fromNodeId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of reverseAdj.get(cur) ?? []) {
        if (!downstream.has(next)) {
          downstream.add(next);
          queue.push(next);
        }
      }
    }

    // 构建初始状态：上游 COMPLETED（保留输出），fromNodeId 及下游 PENDING
    const nodeStates = new Map<string, import("../types/execution").NodeStatus>();
    const nodeOutputs = new Map<string, NodeOutput>();

    for (const node of validation.def.nodes) {
      const id = node.id;
      const isDownstream = id === fromNodeId || downstream.has(id);

      if (isDownstream) {
        nodeStates.set(id, "PENDING");
      } else {
        const prevStatus = snapshot.node_states[id];
        if (prevStatus?.status === "COMPLETED") {
          nodeStates.set(id, "COMPLETED");
          const output = await storage.getOutput(prevRunId, id);
          if (output) nodeOutputs.set(id, output);
        } else {
          throw new WorkflowError(
            `Cannot rerun from '${fromNodeId}': upstream node '${id}' was not COMPLETED (status: ${prevStatus?.status ?? "unknown"})`,
            WorkflowErrorCode.VALIDATION_ERROR,
            { fromNodeId, upstreamNodeId: id },
          );
        }
      }
    }

    // 从上一次运行的 dag.started 事件中恢复 params
    let prevParams: Record<string, unknown> = {};
    try {
      const startEvents = await storage.getEvents(prevRunId, { types: ["dag.started"] });
      const paramsFromEvent = startEvents[0]?.metadata?.params;
      if (paramsFromEvent && typeof paramsFromEvent === "object") {
        prevParams = paramsFromEvent as Record<string, unknown>;
      }
    } catch {
      // 事件读取失败时不阻塞 rerun，使用空 params
    }

    // 生成新 runId，用新调度器执行
    const newRunId = `run_${nanoid(10)}`;
    const baseDir = defaultCwd ?? process.cwd();
    const registry = buildRegistry(newRunId, baseDir);
    const cancellation = new CancellationManager();

    // Secrets 解析
    let secrets: Record<string, string> = {};
    if (validation.def.secrets && validation.def.secrets.length > 0) {
      secrets = await secretsResolver.resolve(validation.def.secrets);
    }

    // 合并 params：先填充 YAML 中定义的默认值，再覆盖上一次运行的 params
    const resolvedParams: Record<string, unknown> = { ...prevParams };
    if (validation.def.params) {
      for (const [key, schema] of Object.entries(validation.def.params)) {
        if (!(key in resolvedParams) && schema.default !== undefined) {
          resolvedParams[key] = schema.default;
        }
      }
    }

    activeRuns.set(newRunId, { cancellation, workflowDef: validation.def, params: resolvedParams, secrets });

    let result: DAGRunResult | undefined;
    try {
      const context: SchedulerContext = {
        runId: newRunId,
        workflowDef: validation.def,
        storage,
        params: resolvedParams,
        secrets,
        nodeExecutor: registry,
        cancellation,
        initialNodeStates: nodeStates,
        initialNodeOutputs: nodeOutputs,
        spawnedEnvIds: new Set<string>(),
      };

      const scheduler = new DAGScheduler(context);
      result = await scheduler.run();
      return result;
    } finally {
      // SUSPENDED 状态保留 activeRun，等待 approveNode 恢复
      if (result?.status !== "SUSPENDED") {
        activeRuns.delete(newRunId);
      }
    }
  }

  return {
    parse,
    validate,
    run,
    runAsync,
    dryRun,
    cancel,
    approveNode,
    getRunStatus,
    getOutput,
    getEvents,
    getPendingApprovals,
    recover,
    rerunFrom,
  };
}
