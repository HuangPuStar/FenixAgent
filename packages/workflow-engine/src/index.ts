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
export { recoverRun } from "./recovery/snapshot-recovery";
export type { RecoveryResult } from "./recovery/snapshot-recovery";
export { topologicalSort, identifyParallelGroups, buildReverseAdjacency } from "./scheduler/topological-sort";
// Transport 接口
export type { AgentRequest, AgentResponse, AgentSession, Transport } from "./transport/transport";
// 执行器
export { ProcessExecutor } from "./executor/process-executor";
export { ApiExecutor } from "./executor/api-executor";
export { RemoteExecutorBase } from "./executor/remote-executor";
export { AgentExecutor } from "./executor/agent-executor";
export { AuditExecutor, verifyApprovalToken } from "./executor/awaitable-executor";
export type { PendingApproval } from "./executor/awaitable-executor";
export { NodeExecutorRegistry, createNodeExecutorRegistry } from "./executor/node-executor";
export { LoopExecutor } from "./executor/loop-executor";
export { SubWorkflowExecutor } from "./executor/sub-workflow-executor";
// Secrets
export { SecretsResolver } from "./secrets/secrets-resolver";
export type { SecretsResolverOptions } from "./secrets/secrets-resolver";
// 引擎门面
export { createWorkflowEngine } from "./engine/workflow-engine";
export type { WorkflowEngine, WorkflowEngineOptions, DryRunResult } from "./engine/workflow-engine";
