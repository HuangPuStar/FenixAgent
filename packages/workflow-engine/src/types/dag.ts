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
export type NodeType = "shell" | "python" | "agent" | "api" | "audit" | "workflow" | "loop" | "transform" | "custom";

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
  /**
   * 输出声明。所有节点类型都可声明，key 为字段名。
   * dag-scheduler 在节点完成后求值 pattern（${{ params.xxx }} / ${{ nodes.Y.output.z }}），
   * 把求值结果（路径字符串）merge 到 NodeOutput.json，下游通过 ${{ nodes.X.output.<key> }} 引用。
   */
  outputs?: Record<
    string,
    {
      pattern: string;
      type: "file" | "file-list" | "dir";
    }
  >;
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

/** Agent 节点 — 复用在线 Environment */
export interface AgentNodeDef extends BaseNodeDef {
  type: "agent";
  /** 环境名称（对应 Environment.name） */
  agent: string;
  /** 发送给 agent 的 prompt */
  prompt: string;
  /** 回传给下游的最后 N 条原始消息（默认 0 = 只传简化 stdout） */
  output_messages?: number;
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

/** Transform 节点 — 纯内存 JSON 变换，通过 JS 表达式重塑上游数据 */
export interface TransformNodeDef extends BaseNodeDef {
  type: "transform";
  /** 从上游拉取的数据，key 为变量名，value 为表达式（如 nodes.X.output） */
  inputs?: Record<string, string>;
  /** 输出结构，key 为字段名，value 为 JavaScript 表达式，表达式作用域包含 inputs 变量 + params + secrets */
  output: Record<string, string>;
}

/** Custom 节点 — 用户自定义工具，通过 tools/ 文件夹注册 */
export interface CustomNodeDef extends BaseNodeDef {
  type: "custom";
  /** 对应 CustomNode.name，从 CustomNodeRegistry 查找 */
  tool: string;
  /** 输入绑定，key 对应 CustomNode.inputs 的 key，value 为表达式字符串 */
  inputs?: Record<string, string>;
  /**
   * Slurm 资源声明（仅当 tool 是 SlurmNode 子类时生效，如通用 slurm 工具）。
   * 字段会注入到 ExecuteContext.slurm，由 SlurmNode 合并到默认 slurmConfig。
   * 不声明则使用工具自带的默认资源。
   */
  slurm?: {
    partition?: string;
    cores?: number;
    nodes?: number;
    memory?: string;
    walltime?: string;
    modules?: string[];
    jobName?: string;
    extraSBATCH?: string[];
  };
  /**
   * Slurm 脚本声明(仅当 tool 是 SlurmNode 子类时生效)。
   * 由 parseScriptConfig 解析,dag-scheduler 求值 ${{ }} 表达式后注入 ExecuteContext.script。
   * SlurmNode 子类必须声明此字段(parseNode 校验),非 Slurm 工具禁止声明。
   */
  script?: {
    content: string;
    env?: Record<string, string>;
  };
  /**
   * Custom 节点的 outputs（继承自 BaseNodeDef）优先由 tool 注册时的 produces 驱动；
   * YAML 中声明的 outputs 可作为覆盖或补充。custom-executor 会校验 outputs key
   * 必须在 tool.produces 列表中（除非 produces 含 "*"）。
   */
  /** 迭代数据源表达式 */
  foreach?: string;
  /** 最大并发子任务数 */
  maxConcurrent?: number;
  /** 子任务失败是否继续，默认 false */
  continueOnError?: boolean;
}

/** 节点定义判别联合 */
export type NodeDef =
  | ShellNodeDef
  | PythonNodeDef
  | AgentNodeDef
  | ApiNodeDef
  | AuditNodeDef
  | SubWorkflowNodeDef
  | LoopNodeDef
  | TransformNodeDef
  | CustomNodeDef;

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
