/**
 * DAG 调度器 — 工作流引擎的核心调度循环。
 *
 * 职责：
 * - 按拓扑序调度节点执行
 * - 并行扇出：同层级无依赖节点并行执行
 * - 错误传播：节点失败时 BFS 标记下游为 SKIPPED
 * - 取消处理：通过 AbortSignal 传播取消
 * - 超时控制：DAG 级别超时自动取消
 * - SUSPENDED 处理：审计节点挂起时暂停整个 DAG
 */

import { nanoid } from "nanoid";
import { resolveTemplate } from "../parser/expression-parser";
import { resolveInputs } from "../parser/inputs-resolver";
import type { StorageAdapter } from "../storage/storage-adapter";
import type { NodeDef, WorkflowDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { DAGEvent, DAGSnapshot, DAGStatus, NodeOutput, NodeStatus, RunSummary } from "../types/execution";
import type { EvalContext } from "../types/expression";
import type { CancellationManager } from "./cancellation";
import { buildReverseAdjacency } from "./topological-sort";

// ---------- 节点执行器接口（Task 5+ 实现） ----------

/** 节点执行上下文 — 传递给 NodeExecutor */
export interface NodeExecutionContext {
  runId: string;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  resolvedInputs: Record<string, unknown>;
  signal: AbortSignal;
  storage: StorageAdapter;
  /** 收集本次运行启动的 Environment ID */
  spawnedEnvIds?: Set<string>;
}

/** 节点执行器接口 — 各节点类型实现此接口 */
export interface NodeExecutor {
  execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput>;
}

// ---------- SuspendedError ----------

/** 审计节点请求人工审批时抛出的错误 */
export class SuspendedError extends WorkflowError {
  constructor(
    message: string,
    public readonly nodeId: string,
    public readonly displayData?: unknown,
  ) {
    super(message, WorkflowErrorCode.RECOVERY_ERROR, { nodeId, displayData });
    this.name = "SuspendedError";
  }
}

// ---------- 调度上下文 ----------

export interface SchedulerContext {
  runId: string;
  workflowDef: WorkflowDef;
  storage: StorageAdapter;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  nodeExecutor: NodeExecutor;
  cancellation: CancellationManager;
  /** 恢复时注入的初始节点状态（跳过已完成的节点） */
  initialNodeStates?: Map<string, NodeStatus>;
  /** 恢复时注入的初始节点输出 */
  initialNodeOutputs?: Map<string, NodeOutput>;
  /** 收集本次运行启动的 Environment ID（由 Transport 层通过回调注入） */
  spawnedEnvIds?: Set<string>;
}

// ---------- 调度结果 ----------

export interface DAGRunResult {
  runId: string;
  status: DAGStatus;
  summary: RunSummary;
  /** 节点输出快照：用于同步调用方在 DAG 完成后立即读取最终节点结果。 */
  outputs?: Record<string, NodeOutput>;
  /** 本次运行期间启动的 Environment ID 列表 */
  spawnedEnvIds?: string[];
}

// ---------- DAGScheduler ----------

export class DAGScheduler {
  private readonly ctx: SchedulerContext;
  private readonly nodes: NodeDef[];
  private readonly nodeMap: Map<string, NodeDef>;
  private readonly reverseAdj: Map<string, string[]>;
  private readonly nodeStates: Map<string, NodeStatus>;
  private readonly nodeOutputs: Map<string, NodeOutput>;
  private lastEventId = "";
  private dagStartTime = "";

  constructor(context: SchedulerContext) {
    this.ctx = context;
    this.nodes = context.workflowDef.nodes;
    this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
    this.reverseAdj = buildReverseAdjacency(this.nodes);
    this.nodeStates = new Map();
    this.nodeOutputs = new Map();
  }

  /** 存储最近的 SuspendedError（从 Promise.allSettled 中提取） */
  private suspendedError: SuspendedError | null = null;

  /**
   * 执行 DAG，返回最终结果。
   *
   * 调度循环：
   * 1. 找到所有 READY 节点（PENDING && 所有依赖 COMPLETED）
   * 2. 并行执行 READY 节点
   * 3. 处理完成/失败/跳过
   * 4. 重复直到无 READY 且无 RUNNING 节点
   */
  async run(): Promise<DAGRunResult> {
    // 初始化节点状态：恢复时使用注入的初始状态，否则全部 PENDING
    if (this.ctx.initialNodeStates) {
      // 注入初始状态（恢复模式）
      for (const [id, status] of this.ctx.initialNodeStates) {
        this.nodeStates.set(id, status);
      }
      // 注入初始输出
      if (this.ctx.initialNodeOutputs) {
        for (const [id, output] of this.ctx.initialNodeOutputs) {
          this.nodeOutputs.set(id, output);
        }
      }
      // 未在初始状态中的节点标记为 PENDING（恢复后继续执行）
      for (const node of this.nodes) {
        if (!this.nodeStates.has(node.id)) {
          this.nodeStates.set(node.id, "PENDING");
        }
      }
    } else {
      for (const node of this.nodes) {
        this.nodeStates.set(node.id, "PENDING");
      }
    }

    this.dagStartTime = new Date().toISOString();

    // DAG 级别超时信号（timeout 字段单位为秒，转换为毫秒）
    const dagTimeout = this.ctx.workflowDef.timeout;
    let timeoutSignal: AbortSignal | undefined;
    if (dagTimeout) {
      timeoutSignal = AbortSignal.timeout(dagTimeout * 1000);
      timeoutSignal.addEventListener(
        "abort",
        () => {
          this.ctx.cancellation.cancel();
        },
        { once: true },
      );
    }

    // 发射 dag.started 事件（携带 params 供 rerunFrom/recover 恢复）
    const startEventId = await this.emitEvent("dag.started", undefined, {
      params: this.ctx.params,
    });
    await this.createSnapshot("RUNNING", startEventId);

    try {
      // 主调度循环
      while (true) {
        // 检查取消
        if (this.ctx.cancellation.cancelled) {
          break;
        }

        // 检查 SUSPENDED��从上一轮 executeNode 中捕获）
        if (this.suspendedError) {
          break;
        }

        // 找到 READY 节点
        const readyNodes = this.findReadyNodes();

        // 检查是否有 RUNNING 节点
        const hasRunning = this.hasStatus("RUNNING");

        if (readyNodes.length === 0 && !hasRunning) {
          // DAG 完成
          break;
        }

        if (readyNodes.length > 0) {
          // 并行执行所有 READY 节点
          const promises = readyNodes.map((node) => this.executeNode(node));
          const results = await Promise.allSettled(promises);

          // 从 allSettled 结果中提取 SuspendedError
          for (const r of results) {
            if (r.status === "rejected" && r.reason instanceof SuspendedError) {
              this.suspendedError = r.reason;
              break;
            }
          }
        }

        // 短暂让出事件循环，避免忙等待
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // 计算最终状态
      const finalStatus = this.computeFinalStatus();
      const completedAt = new Date().toISOString();

      // 发射 dag.completed 或 dag.cancelled 事件
      if (finalStatus === "CANCELLED") {
        await this.emitEvent("dag.cancelled");
        // 标记所有 RUNNING 节点为 CANCELLED
        for (const [id, status] of this.nodeStates) {
          if (status === "RUNNING") {
            this.nodeStates.set(id, "CANCELLED");
            await this.emitEvent("node.cancelled", id);
          }
        }
      } else if (finalStatus === "SUSPENDED") {
        // SUSPENDED 事件已在 executeNode 中发射
      } else {
        await this.emitEvent("dag.completed");
      }

      const snapshotEventId = this.lastEventId;
      await this.createSnapshot(finalStatus, snapshotEventId);

      const summary = this.buildSummary(finalStatus, completedAt);
      return {
        runId: this.ctx.runId,
        status: finalStatus,
        summary,
        // storage 持久化可能在不同适配器上存在可见性延迟；返回内存中的最终输出给同步 API 直接使用。
        outputs: Object.fromEntries(this.nodeOutputs.entries()),
        spawnedEnvIds: this.ctx.spawnedEnvIds ? [...this.ctx.spawnedEnvIds] : [],
      };
    } catch (error) {
      // 未预期的异常 → ERROR 状态
      console.error(`[workflow] DAG unexpected error: runId=${this.ctx.runId}`, error);
      const completedAt = new Date().toISOString();
      await this.emitEvent("dag.cancelled");
      const summary = this.buildSummary("ERROR", completedAt);
      return {
        runId: this.ctx.runId,
        status: "ERROR",
        summary,
        // 即使 DAG 异常，也保留已完成节点输出，便于调用方排查失败前的执行结果。
        outputs: Object.fromEntries(this.nodeOutputs.entries()),
        spawnedEnvIds: this.ctx.spawnedEnvIds ? [...this.ctx.spawnedEnvIds] : [],
      };
    }
  }

  // ---------- 私有方法 ----------

  /** 找到所有 READY 节点：PENDING 且所有依赖 COMPLETED */
  private findReadyNodes(): NodeDef[] {
    const ready: NodeDef[] = [];
    for (const node of this.nodes) {
      const status = this.nodeStates.get(node.id);
      if (status !== "PENDING") continue;

      const deps = node.depends_on ?? [];
      const allDepsCompleted = deps.every((depId) => this.nodeStates.get(depId) === "COMPLETED");
      if (allDepsCompleted) {
        ready.push(node);
      }
    }
    return ready;
  }

  /** 检查是否有指定状态的节点 */
  private hasStatus(status: NodeStatus): boolean {
    for (const s of this.nodeStates.values()) {
      if (s === status) return true;
    }
    return false;
  }

  /** 执行单个节点 */
  private async executeNode(node: NodeDef): Promise<void> {
    const nodeId = node.id;

    // 再次检查取消
    if (this.ctx.cancellation.cancelled) {
      this.nodeStates.set(nodeId, "CANCELLED");
      await this.emitEvent("node.cancelled", nodeId);
      return;
    }

    // 设置 RUNNING（执行器内部会发射 node.started 事件）
    this.nodeStates.set(nodeId, "RUNNING");

    // 保存快照让前端轮询能立即看到 RUNNING 状态，
    // 否则快照只在 DAG 启动和节点完成后才创建，RUNNING 状态对外不可见
    await this.saveSnapshotCurrent();

    try {
      // 解析 ${{ }} 表达式
      const resolvedInputs = this.resolveNodeInputs(node);

      // 构建执行上下文
      const execCtx: NodeExecutionContext = {
        runId: this.ctx.runId,
        params: this.ctx.params,
        secrets: this.ctx.secrets,
        resolvedInputs,
        signal: this.ctx.cancellation.signal,
        storage: this.ctx.storage,
        spawnedEnvIds: this.ctx.spawnedEnvIds,
      };

      // 执行节点（执行器内部发射 node.started / node.completed 事件）
      const output = await this.ctx.nodeExecutor.execute(node, execCtx);

      // 求值节点 yaml 声明的 outputs.pattern，merge 到 output.json。
      // 让下游能通过 ${{ nodes.X.output.K }} 引用 X 声明的具名输出（如 trimmed_r1 / bam）。
      // 放在 setNodeOutputs 之前，确保下游 buildEvalContext 时能拿到注入后的 output。
      this.injectDeclaredOutputs(node, output);

      // 成功 → COMPLETED + 快照（不再发射额外的 node.completed 事件）
      this.nodeStates.set(nodeId, "COMPLETED");
      this.nodeOutputs.set(nodeId, output);
      this.lastEventId = `evt_${nanoid(10)}`;
      await this.saveSnapshotAfterNode(nodeId, output);
    } catch (error) {
      // 处理 SUSPENDED
      if (error instanceof SuspendedError) {
        this.nodeStates.set(nodeId, "SUSPENDED" as NodeStatus);
        await this.emitEvent("audit.requested", nodeId, {
          display_data: error.displayData,
        });
        // 重新抛出让 run() 通过 allSettled 捕获
        throw error;
      }

      const nodeType = this.nodeMap.get(nodeId)?.type ?? "unknown";

      // 处理 AbortError（取消 / 超时）
      if (error instanceof DOMException && error.name === "AbortError") {
        this.nodeStates.set(nodeId, "CANCELLED");
        await this.emitEvent("node.cancelled", nodeId);
        console.error(`[workflow] Node CANCELLED: nodeId=${nodeId} type=${nodeType} reason=${error.message}`);
        return;
      }

      // 节点失败
      this.nodeStates.set(nodeId, "FAILED");

      const failureOutput = this.extractFailureOutput(error);
      if (failureOutput) {
        this.nodeOutputs.set(nodeId, failureOutput);
        this.lastEventId = `evt_${nanoid(10)}`;
        await this.saveSnapshotAfterNode(nodeId, failureOutput);
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorDetail =
        error instanceof WorkflowError && error.details?.abort_reason
          ? ` reason=${error.details.abort_reason as string}`
          : "";
      console.error(`[workflow] Node FAILED: nodeId=${nodeId} type=${nodeType} error=${errorMsg}${errorDetail}`);

      // BFS 错误传播：标记下游为 SKIPPED
      await this.propagateFailure(nodeId);
    }
  }

  /** 解析节点输入中的 ${{ }} 表达式 */
  private resolveNodeInputs(node: NodeDef): Record<string, unknown> {
    const evalContext = this.buildEvalContext();

    const resolved: Record<string, unknown> = {};

    // 解析各节点类型特有的字段
    switch (node.type) {
      case "shell": {
        // Shell 节点：command 不做模板解析，通过 inputs 注入环境变量
        resolved.command = node.command;
        if (node.cwd) resolved.cwd = node.cwd;
        if (node.inputs) {
          resolved.inputs = resolveInputs(node.inputs, evalContext);
        }
        break;
      }
      case "agent": {
        resolved.prompt = resolveTemplate(node.prompt, evalContext);
        if (node.agent) resolved.agent = resolveTemplate(node.agent, evalContext);
        break;
      }
      case "api": {
        resolved.url = resolveTemplate(node.url, evalContext);
        if (node.body) resolved.body = resolveTemplate(node.body, evalContext);
        if (node.headers) {
          resolved.headers = Object.fromEntries(
            Object.entries(node.headers).map(([k, v]) => [k, resolveTemplate(v, evalContext)]),
          );
        }
        break;
      }
      case "audit": {
        resolved.display_data = node.display_data;
        break;
      }
      case "python": {
        // Python 节点：code 不做模板解析，通过 inputs 注入变量
        resolved.code = node.code;
        if (node.requirements) resolved.requirements = node.requirements;
        if (node.cwd) resolved.cwd = node.cwd;
        if (node.inputs) {
          resolved.inputs = resolveInputs(node.inputs, evalContext);
        }
        break;
      }
      case "workflow": {
        resolved.ref = resolveTemplate(node.ref, evalContext);
        if (node.params) {
          resolved.params = Object.fromEntries(
            Object.entries(node.params).map(([k, v]) => {
              if (typeof v === "string") return [k, resolveTemplate(v, evalContext)];
              return [k, v];
            }),
          );
        }
        break;
      }
      case "loop": {
        resolved.condition = resolveTemplate(node.condition, evalContext);
        resolved.max_iterations = node.max_iterations;
        break;
      }
      case "transform": {
        // Transform 节点：通过 inputs 注入上游数据，output 表达式在 executor 内求值
        if (node.inputs) {
          resolved.inputs = resolveInputs(node.inputs, evalContext);
        }
        break;
      }
      case "custom": {
        // Custom 节点：通过 inputs 注入上游数据，executor 内做 Zod 校验
        const customNode = node as import("../types/dag").CustomNodeDef;
        if (customNode.inputs) {
          resolved.inputs = resolveInputs(customNode.inputs, evalContext);
        }
        // script 求值(仅 SlurmNode 子类会声明 script 字段，解析器已校验 kind)
        if (customNode.script) {
          resolved.script = {
            // content: 走 resolveTemplate(拼接模式，结果始终是 string)
            content: resolveTemplate(customNode.script.content, evalContext),
            // env: 遍历每个 value 走 resolveTemplate，统一转 string
            env: customNode.script.env
              ? Object.fromEntries(
                  Object.entries(customNode.script.env).map(([k, v]) => [k, resolveTemplate(v, evalContext)]),
                )
              : {},
          };
        }
        break;
      }
      case "end": {
        // end 节点：解析 inputs 为模板变量值，供 EndExecutor 收集为最终输出
        const endNode = node as import("../types/dag").EndNodeDef;
        if (endNode.inputs) {
          resolved.inputs = resolveInputs(endNode.inputs, evalContext);
        }
        break;
      }
    }

    // 通用字段
    if (node.condition) {
      resolved.condition = resolveTemplate(node.condition, evalContext);
    }
    if (node.env) {
      if (node.type === "shell" || node.type === "python") {
        resolved.env = node.env;
      } else {
        resolved.env = Object.fromEntries(
          Object.entries(node.env).map(([k, v]) => [k, resolveTemplate(v, evalContext)]),
        );
      }
    }

    return resolved;
  }

  /** 构建表达式求值上下文 */
  private buildEvalContext(): EvalContext {
    const nodes: Record<string, { output: Record<string, unknown>; status: string }> = {};
    for (const [id, status] of this.nodeStates) {
      const output = this.nodeOutputs.get(id);
      // json 可能是数字/字符串等非对象值（如 echo "1000" 被 JSON.parse 解析为 number 1000），
      // 此时应回退到 { stdout } 以确保下游通过 .output.stdout 能正确取值。
      // 同时 merge stdout 兜底字段，避免 injectDeclaredOutputs 后的 jsonObj 缺少 stdout。
      const jsonObj =
        output?.json !== null && typeof output?.json === "object" && !Array.isArray(output?.json)
          ? (output.json as Record<string, unknown>)
          : null;
      nodes[id] = {
        output: (jsonObj ? { stdout: output?.stdout ?? "", ...jsonObj } : { stdout: output?.stdout ?? "" }) as Record<
          string,
          unknown
        >,
        status,
      };
    }
    return {
      nodes,
      params: this.ctx.params,
      secrets: this.ctx.secrets,
    };
  }

  /**
   * 求值节点 yaml 声明的 outputs.pattern，merge 到 output.json。
   *
   * 设计目的：让下游节点能通过 ${{ nodes.X.output.K }} 引用 X 节点声明的具名输出
   * （如 trimmed_r1 / bam / quant_sf），实现真正的 DAG 数据流，下游不再硬编码路径。
   *
   * 求值时机：节点 execute 成功后、存入 nodeOutputs 之前。
   * - 此时 buildEvalContext 包含 params / secrets / 已完成的上游节点 output，
   *   pattern 里的 ${{ params.xxx }} / ${{ nodes.Y.output.z }} 都能正确解析。
   * - pattern 不引用自身节点输出（语义上 outputs 是"该节点对外暴露的产物声明"，
   *   只依赖 params 和上游），所以不会循环。
   *
   * merge 策略：output.json 已是对象则合并（声明的 outputs 覆盖同名字段，
   * 保留脚本主动 echo 的 JSON 字段）；否则直接用声明 outputs 作为 json。
   * pattern 求值失败不阻塞节点完成，记录 warn 后跳过该 key（下游引用时拿到 undefined）。
   */
  private injectDeclaredOutputs(node: NodeDef, output: NodeOutput): void {
    const declared = node.outputs;
    if (!declared || Object.keys(declared).length === 0) return;

    const evalContext = this.buildEvalContext();
    const injected: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(declared)) {
      const pattern = def?.pattern;
      if (typeof pattern !== "string" || !pattern.trim()) continue;
      try {
        injected[key] = resolveTemplate(pattern, evalContext);
      } catch (err) {
        console.warn(
          `[dag-scheduler] Failed to resolve outputs.${key} for node ${node.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (Object.keys(injected).length === 0) return;

    const existing = output.json;
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      output.json = { ...(existing as Record<string, unknown>), ...injected };
    } else {
      output.json = injected;
    }
  }

  /** BFS 错误传播 — 标记所有下游节点为 SKIPPED */
  private async propagateFailure(failedNodeId: string): Promise<void> {
    const visited = new Set<string>();
    const queue = this.reverseAdj.get(failedNodeId) ?? [];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const status = this.nodeStates.get(nodeId);
      // 只标记 PENDING 的节点，不影响 RUNNING/COMPLETED 节点
      if (status === "PENDING") {
        this.nodeStates.set(nodeId, "SKIPPED");
        await this.emitEvent("node.skipped", nodeId, {
          reason: "upstream_failed",
        });
      }

      // 继续传播到下游
      const downstream = this.reverseAdj.get(nodeId) ?? [];
      queue.push(...downstream);
    }
  }

  /**
   * 从执行器抛出的错误中提取失败输出。
   *
   * 关键：必须把 stderr 也带入 stdout（拼在末尾），否则前端"输出"面板只看到
   * "exit_code: 1 / 0B 输出"，完全不知道脚本里哪条命令挂了。
   * 这与 SlurmNode.collectOutput 的做法一致：NodeOutput 没有 stderr 字段，
   * 非空 stderr 拼到 stdout 末尾。
   */
  private extractFailureOutput(error: unknown): NodeOutput | null {
    if (error instanceof WorkflowError && error.details) {
      const rawStdout = (error.details.stdout as string) ?? "";
      const rawStderr = (error.details.stderr as string) ?? "";
      const exitCode = (error.details.exit_code as number) ?? 1;
      // 拼接顺序：原始 stdout → stderr（如有）→ error.message（stdout 为空时才附）
      // stdout 为空时附上 error.message，让用户在前端至少看到一句可读错误
      const parts: string[] = [];
      if (rawStdout) parts.push(rawStdout);
      if (rawStderr) parts.push(`[stderr]\n${rawStderr}`);
      if (parts.length === 0) parts.push(error.message);
      const stdout = parts.join("\n\n");
      return {
        stdout,
        exit_code: exitCode,
        size: Buffer.byteLength(stdout),
      };
    }
    if (error instanceof Error) {
      return {
        stdout: error.message,
        exit_code: 1,
        size: Buffer.byteLength(error.message),
      };
    }
    return null;
  }

  /** 计算最终 DAG 状态 */
  private computeFinalStatus(): DAGStatus {
    if (this.ctx.cancellation.cancelled) {
      return "CANCELLED";
    }

    // 检查是否有 SUSPENDED 节点（SuspendedError 抛出后不会走到这里，但保险起见）
    for (const status of this.nodeStates.values()) {
      if (status === ("SUSPENDED" as NodeStatus)) {
        return "SUSPENDED";
      }
    }

    let hasFailed = false;
    let _hasSkipped = false;
    let allCompleted = true;

    for (const status of this.nodeStates.values()) {
      if (status === "FAILED") {
        hasFailed = true;
        allCompleted = false;
      } else if (status === "SKIPPED" || status === "CANCELLED") {
        _hasSkipped = true;
        allCompleted = false;
      } else if (status !== "COMPLETED") {
        allCompleted = false;
      }
    }

    if (allCompleted) return "SUCCESS";
    if (hasFailed) return "FAILED";
    return "FAILED"; // hasSkipped or partial completion
  }

  /** 构建运行摘要 */
  private buildSummary(status: DAGStatus, completedAt: string): RunSummary {
    let completed = 0;
    let failed = 0;
    let running = 0;

    for (const s of this.nodeStates.values()) {
      if (s === "COMPLETED") completed++;
      else if (s === "FAILED") failed++;
      else if (s === "RUNNING") running++;
    }

    return {
      run_id: this.ctx.runId,
      workflow_name: this.ctx.workflowDef.name,
      status,
      started_at: this.dagStartTime,
      completed_at: completedAt,
      node_summary: {
        total: this.nodes.length,
        completed,
        failed,
        running,
      },
    };
  }

  /** 发射事件 */
  private async emitEvent(
    type: DAGEvent["type"],
    nodeId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const event: DAGEvent = {
      event_id: `evt_${nanoid(10)}`,
      run_id: this.ctx.runId,
      timestamp: new Date().toISOString(),
      type,
      ...(nodeId ? { node_id: nodeId } : {}),
      ...(nodeId ? { node_type: this.nodeMap.get(nodeId)?.type } : {}),
      ...(metadata ? { metadata } : {}),
    };
    this.lastEventId = event.event_id;
    await this.ctx.storage.appendEvent(event);
    return event.event_id;
  }

  /** 创建快照 */
  private async createSnapshot(status: DAGStatus, lastEventId: string): Promise<void> {
    const nodeStates: DAGSnapshot["node_states"] = {};
    for (const [id, s] of this.nodeStates) {
      const output = this.nodeOutputs.get(id);
      nodeStates[id] = {
        status: s,
        ...(output?.exit_code != null ? { exit_code: output.exit_code } : {}),
      };
    }

    const snapshot: DAGSnapshot = {
      snapshot_id: `snap_${nanoid(10)}`,
      run_id: this.ctx.runId,
      last_event_id: lastEventId,
      timestamp: new Date().toISOString(),
      node_states: nodeStates,
      dag_status: status,
    };
    await this.ctx.storage.createSnapshot(snapshot);
  }

  /** 节点完成后写入输出 + 快照（不发射事件，事件由执行器负责） */
  private async saveSnapshotAfterNode(nodeId: string, output: NodeOutput): Promise<void> {
    await this.ctx.storage.setOutput(this.ctx.runId, nodeId, output);

    const nodeStates: DAGSnapshot["node_states"] = {};
    for (const [id, s] of this.nodeStates) {
      const nodeOutput = this.nodeOutputs.get(id);
      nodeStates[id] = {
        status: s,
        ...(nodeOutput?.exit_code != null ? { exit_code: nodeOutput.exit_code } : {}),
      };
    }

    const snapshot: DAGSnapshot = {
      snapshot_id: `snap_${nanoid(10)}`,
      run_id: this.ctx.runId,
      last_event_id: this.lastEventId,
      timestamp: new Date().toISOString(),
      node_states: nodeStates,
      dag_status: "RUNNING",
    };

    await this.ctx.storage.createSnapshot(snapshot);
  }

  /** 保存当前内存状态的快照（用于节点状态转为 RUNNING 时，让前端轮询能感知） */
  private async saveSnapshotCurrent(): Promise<void> {
    const nodeStates: DAGSnapshot["node_states"] = {};
    for (const [id, s] of this.nodeStates) {
      const nodeOutput = this.nodeOutputs.get(id);
      nodeStates[id] = {
        status: s,
        ...(nodeOutput?.exit_code != null ? { exit_code: nodeOutput.exit_code } : {}),
      };
    }

    const snapshot: DAGSnapshot = {
      snapshot_id: `snap_${nanoid(10)}`,
      run_id: this.ctx.runId,
      last_event_id: this.lastEventId,
      timestamp: new Date().toISOString(),
      node_states: nodeStates,
      dag_status: "RUNNING",
    };

    await this.ctx.storage.createSnapshot(snapshot);
  }
}
