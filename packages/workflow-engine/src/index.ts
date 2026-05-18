/**
 * `@mothership/workflow-engine` 的公开导出面。
 *
 * 原生 DAG 工作流执行引擎的类型定义和错误类型。
 */

export type { ValidationIssue, ValidationResult } from "./parser/dag-validator";
export { validateDAG } from "./parser/dag-validator";
export { evaluateExpression, parseExpression, resolveTemplate } from "./parser/expression-parser";
// 解析器
export { parseWorkflowYaml } from "./parser/yaml-parser";
// DAG 类型
export type {
  AgentNodeDef,
  ApiNodeDef,
  AuditNodeDef,
  BaseNodeDef,
  LoopBody,
  LoopNodeDef,
  NodeDef,
  NodeType,
  ParamDef,
  RetryConfig,
  ShellNodeDef,
  SubWorkflowNodeDef,
  WorkflowDef,
} from "./types/dag";
// 错误类型（enum 和 class 用 export）
export { WorkflowError, WorkflowErrorCode } from "./types/errors";
// 执行类型
export type {
  DAGEvent,
  DAGSnapshot,
  DAGStatus,
  EventType,
  NodeOutput,
  NodeStatus,
  RunSummary,
} from "./types/execution";
// 表达式类型
export type { ASTNode, EvalContext } from "./types/expression";
// 存储接口 + 内存实现
export type { StorageAdapter } from "./storage/storage-adapter";
export { createInMemoryStorage } from "./storage/in-memory-storage";
// 调度器
export { DAGScheduler, SuspendedError } from "./scheduler/dag-scheduler";
export type { DAGRunResult, NodeExecutor, NodeExecutionContext, SchedulerContext } from "./scheduler/dag-scheduler";
export { CancellationManager } from "./scheduler/cancellation";
export { topologicalSort, identifyParallelGroups, buildReverseAdjacency } from "./scheduler/topological-sort";
// 执行器
export { ProcessExecutor } from "./executor/process-executor";
export { NodeExecutorRegistry, createNodeExecutorRegistry } from "./executor/node-executor";
