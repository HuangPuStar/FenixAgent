/** 参数定义 */
export interface ParamDef {
  type?: "string" | "number" | "boolean" | "object";
  default?: unknown;
  required?: boolean;
}

/** 重试配置 */
export interface RetryConfig {
  count: number;
  /** 默认 1 秒 */
  delay?: number;
  /** 默认 fixed */
  backoff?: "fixed" | "exponential";
}

/** 节点类型 */
export type NodeType = "shell" | "python" | "agent" | "api" | "audit" | "workflow" | "loop";

/** 基础节点定义 */
export interface BaseNodeDef {
  id: string;
  type: NodeType;
  /** 节点描述，用于说明该节点的用途 */
  description?: string;
  depends_on?: string[];
  condition?: string;
  timeout?: number;
  retry?: RetryConfig;
  env?: Record<string, string>;
}

/** Shell 节点 — 执行命令 */
export interface ShellNodeDef extends BaseNodeDef {
  type: "shell";
  command: string | string[];
  cwd?: string;
  /** 显式声明需要注入为环境变量的上游数据，key 为环境变量名，value 为表达式 */
  inputs?: Record<string, string>;
}

/** Python 节点 — 执行 Python 脚本 */
export interface PythonNodeDef extends BaseNodeDef {
  type: "python";
  code: string;
  requirements?: string[];
  cwd?: string;
  /** 显式声明需要注入为 Python 变量的上游数据，key 为变量名，value 为表达式 */
  inputs?: Record<string, string>;
}

/** Agent 节点 — 调用 AI Agent */
export interface AgentNodeDef extends BaseNodeDef {
  type: "agent";
  prompt: string;
  agent?: string;
  skill?: string;
  /** 节点级模型覆盖（覆盖 agent config 的 model） */
  model?: string;
  /** 节点级温度覆盖 */
  temperature?: number;
  /** 节点级最大步数覆盖 */
  steps?: number;
  retry?: RetryConfig;
}

/** API 节点 — HTTP 请求 */
export interface ApiNodeDef extends BaseNodeDef {
  type: "api";
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
}

/** 审计节点 — 人工审��门 */
export interface AuditNodeDef extends BaseNodeDef {
  type: "audit";
  display_data?: unknown;
  expires_in?: number;
}

/** 子工作流节点 */
export interface SubWorkflowNodeDef extends BaseNodeDef {
  type: "workflow";
  ref: string;
  params?: Record<string, unknown>;
  ignore_errors?: boolean;
}

/** 循环节点体 */
export interface LoopBody {
  nodes: NodeDef[];
}

/** 循环节点 */
export interface LoopNodeDef extends BaseNodeDef {
  type: "loop";
  condition: string;
  max_iterations: number;
  body: LoopBody;
}

/** 节点定义判别联合 */
export type NodeDef =
  | ShellNodeDef
  | PythonNodeDef
  | AgentNodeDef
  | ApiNodeDef
  | AuditNodeDef
  | SubWorkflowNodeDef
  | LoopNodeDef;

/** WorkflowDef — YAML 根结构 */
export interface WorkflowDef {
  schema_version: string;
  name: string;
  description?: string;
  params?: Record<string, ParamDef>;
  secrets?: string[];
  timeout?: number;
  nodes: NodeDef[];
  /** 内部字段：起始节点 ID */
  _startNodeId?: string;
  /** 内部字段：工作流定义所在目录 */
  _baseDir?: string;
}
