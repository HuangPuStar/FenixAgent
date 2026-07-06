/**
 * `@fenix/workflow-engine` 的公开导出面。
 *
 * 原生 DAG 工作流执行引擎的类型定义和错误类型。
 */

export type { DryRunResult, WorkflowEngine, WorkflowEngineOptions } from "./engine/workflow-engine";
// 引擎门面
export { createWorkflowEngine } from "./engine/workflow-engine";
export { AgentExecutor } from "./executor/agent-executor";
export { ApiExecutor } from "./executor/api-executor";
export type { PendingApproval } from "./executor/awaitable-executor";
export { AuditExecutor, verifyApprovalToken } from "./executor/awaitable-executor";
export { EndExecutor } from "./executor/end-executor";
export { LoopExecutor } from "./executor/loop-executor";
export { createNodeExecutorRegistry, NodeExecutorRegistry } from "./executor/node-executor";
// 执行器
export { ProcessExecutor } from "./executor/process-executor";
// Python 执行器
export { PythonExecutor } from "./executor/python-executor";
export { RemoteExecutorBase } from "./executor/remote-executor";
export { SubWorkflowExecutor } from "./executor/sub-workflow-executor";
export type { ValidationIssue, ValidationResult } from "./parser/dag-validator";
export { validateDAG } from "./parser/dag-validator";
export { evaluateExpression, parseExpression, resolveTemplate } from "./parser/expression-parser";
export type { ResolvedInput } from "./parser/inputs-resolver";
// Inputs 解析器
export { generatePythonPreamble, generateShellEnvVars, resolveInputs } from "./parser/inputs-resolver";
// 解析器
export type { ParseOptions } from "./parser/yaml-parser";
export { parseWorkflowYaml } from "./parser/yaml-parser";
export { CustomNodeExecutor } from "./plugins/custom-executor";
export type { JobTransport } from "./plugins/job-transport";
export { SshJobTransport } from "./plugins/job-transport";
export { CustomNodeRegistry } from "./plugins/registry";
export { BunSshExecutor, mapSlurmState, SlurmNode } from "./plugins/slurm-node";
// SlurmNode 插件
export type { JobResult, ScriptDef, SlurmConfig, SshExecutor } from "./plugins/slurm-types";
// 自定义节点插件系统
export type { CustomNode, ExecuteContext, InputDef } from "./plugins/types";
export type { RecoveryResult } from "./recovery/snapshot-recovery";
export { recoverRun } from "./recovery/snapshot-recovery";
export { CancellationManager } from "./scheduler/cancellation";
export type { DAGRunResult, NodeExecutionContext, NodeExecutor, SchedulerContext } from "./scheduler/dag-scheduler";
// 调度器
export { DAGScheduler, SuspendedError } from "./scheduler/dag-scheduler";
export { buildReverseAdjacency, identifyParallelGroups, topologicalSort } from "./scheduler/topological-sort";
export type { SecretsResolverOptions } from "./secrets/secrets-resolver";
// Secrets
export { SecretsResolver } from "./secrets/secrets-resolver";
export { createInMemoryStorage } from "./storage/in-memory-storage";
// 存储接口 + 内存实现
export type { StorageAdapter } from "./storage/storage-adapter";
// Transport 接口
export type { AgentMessage, AgentRequest, AgentResponse, AgentSession, Transport } from "./transport/transport";
// DAG 类型
export type {
  AgentNodeDef,
  ApiNodeDef,
  AuditNodeDef,
  BaseNodeDef,
  CustomNodeDef,
  LoopBody,
  LoopNodeDef,
  NodeDef,
  NodeType,
  ParamDef,
  RetryConfig,
  ShellNodeDef,
  SubWorkflowNodeDef,
  TransformNodeDef,
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
