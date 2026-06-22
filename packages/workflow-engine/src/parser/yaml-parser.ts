/**
 * YAML 解析器 — 将 workflow.yaml 源码解析为 WorkflowDef
 *
 * 使用 yaml 包（core schema）解析，校验 schema_version、必填字段、节点类型等。
 * 无 depends_on �� depends_on 为空的节点绑定到虚拟起始节点。
 */

import { parse as yamlParse } from "yaml";
import type { CustomNodeRegistry } from "../plugins/registry";
import type { CustomNodeDef, NodeDef, NodeType, WorkflowDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";

const VALID_NODE_TYPES: NodeType[] = [
  "shell",
  "python",
  "agent",
  "api",
  "audit",
  "workflow",
  "loop",
  "transform",
  "custom",
];

/** parseWorkflowYaml 的额外选项 */
export interface ParseOptions {
  /** CustomNodeRegistry 实例，用于校验 tool 存在性 + produces 匹配 */
  customRegistry?: CustomNodeRegistry;
}

/**
 * 将 YAML 源码解析为 WorkflowDef
 * @param source  YAML 字符串
 * @param baseDir 工作流定义所在目录，默认 process.cwd()
 * @throws WorkflowError(INVALID_YAML) 格式错误
 */
export function parseWorkflowYaml(source: string, baseDir?: string, opts?: ParseOptions): WorkflowDef {
  let doc: unknown;
  try {
    doc = yamlParse(source);
  } catch (e) {
    throw new WorkflowError(`YAML parse error: ${(e as Error).message}`, WorkflowErrorCode.INVALID_YAML, { cause: e });
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new WorkflowError("YAML root must be a mapping", WorkflowErrorCode.INVALID_YAML);
  }

  const raw = doc as Record<string, unknown>;

  // 检测 acpx-g 格式
  if ("kind" in raw && "metadata" in raw && "spec" in raw) {
    throw new WorkflowError(
      "Detected acpx-g format YAML — only schema_version format is supported",
      WorkflowErrorCode.INVALID_YAML,
    );
  }

  // schema_version
  if (!("schema_version" in raw)) {
    throw new WorkflowError("Missing required field: 'schema_version'", WorkflowErrorCode.INVALID_YAML);
  }
  const schemaVersion = String(raw.schema_version);
  if (schemaVersion !== "1") {
    throw new WorkflowError(
      `Unsupported schema_version: '${schemaVersion}', expected '1'`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }

  // name
  if (!("name" in raw) || typeof raw.name !== "string" || !raw.name.trim()) {
    throw new WorkflowError("Missing required field: 'name'", WorkflowErrorCode.INVALID_YAML);
  }

  // params（可选）
  if ("params" in raw && raw.params) {
    if (typeof raw.params !== "object" || Array.isArray(raw.params)) {
      throw new WorkflowError("'params' must be a mapping", WorkflowErrorCode.INVALID_YAML);
    }
  }

  // nodes（必填）
  if (!("nodes" in raw) || !Array.isArray(raw.nodes)) {
    throw new WorkflowError("Missing required field: 'nodes' (must be an array)", WorkflowErrorCode.INVALID_YAML);
  }

  const nodes: NodeDef[] = raw.nodes.map((n: unknown, i: number) => parseNode(n, i, opts));

  // 识别隐式起始节点：无 depends_on 或 depends_on 为空数组
  const startNodes = nodes.filter((n) => !n.depends_on || n.depends_on.length === 0);

  return {
    schema_version: schemaVersion,
    name: raw.name as string,
    description: typeof raw.description === "string" ? raw.description : undefined,
    params: (raw.params as WorkflowDef["params"]) ?? undefined,
    secrets: Array.isArray(raw.secrets) ? (raw.secrets as string[]) : undefined,
    timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    nodes,
    _startNodeId: startNodes.length === 1 ? startNodes[0].id : undefined,
    _baseDir: baseDir ?? process.cwd(),
  };
}

/**
 * 解析单个节点定义
 */
function parseNode(raw: unknown, index: number, opts?: ParseOptions): NodeDef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowError(`nodes[${index}] must be a mapping`, WorkflowErrorCode.INVALID_YAML);
  }

  const n = raw as Record<string, unknown>;

  // id
  if (typeof n.id !== "string" || !n.id.trim()) {
    throw new WorkflowError(`nodes[${index}]: missing or empty 'id'`, WorkflowErrorCode.INVALID_YAML);
  }

  // type
  if (typeof n.type !== "string" || !VALID_NODE_TYPES.includes(n.type as NodeType)) {
    throw new WorkflowError(
      `nodes[${index}] (${n.id}): invalid type '${n.type}', must be one of: ${VALID_NODE_TYPES.join(", ")}`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }

  const type = n.type as NodeType;
  const base = {
    id: n.id as string,
    type,
    depends_on: Array.isArray(n.depends_on) ? (n.depends_on as string[]) : undefined,
    condition: typeof n.condition === "string" ? n.condition : undefined,
    timeout: typeof n.timeout === "number" ? n.timeout : undefined,
    env: isRecord(n.env) ? (n.env as Record<string, string>) : undefined,
  };

  switch (type) {
    case "shell": {
      if (!("command" in n)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): shell node requires 'command'`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      return {
        ...base,
        type: "shell",
        command: n.command as string | string[],
        cwd: typeof n.cwd === "string" ? n.cwd : undefined,
        inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
      };
    }
    case "python": {
      if (!("code" in n)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): python node requires 'code'`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      return {
        ...base,
        type: "python",
        code: n.code as string,
        requirements: Array.isArray(n.requirements) ? (n.requirements as string[]) : undefined,
        cwd: typeof n.cwd === "string" ? n.cwd : undefined,
        inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
      };
    }
    case "agent": {
      if (!("prompt" in n)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): agent node requires 'prompt'`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      if (!("agent" in n) || typeof n.agent !== "string" || !n.agent) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): agent node requires 'agent' (environment name)`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      return {
        ...base,
        type: "agent",
        prompt: n.prompt as string,
        agent: n.agent as string,
        output_messages: typeof n.output_messages === "number" ? n.output_messages : undefined,
      };
    }
    case "api": {
      if (!("url" in n)) {
        throw new WorkflowError(`nodes[${index}] (${n.id}): api node requires 'url'`, WorkflowErrorCode.INVALID_YAML);
      }
      return {
        ...base,
        type: "api",
        url: n.url as string,
        method: typeof n.method === "string" ? (n.method as "GET" | "POST" | "PUT" | "DELETE") : undefined,
        headers: isRecord(n.headers) ? (n.headers as Record<string, string>) : undefined,
        body: typeof n.body === "string" ? n.body : undefined,
      };
    }
    case "audit":
      return {
        ...base,
        type: "audit",
        display_data: n.display_data,
        expires_in: typeof n.expires_in === "number" ? n.expires_in : undefined,
      };
    case "workflow": {
      if (!("ref" in n)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): workflow node requires 'ref'`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      return {
        ...base,
        type: "workflow",
        ref: n.ref as string,
        params: isRecord(n.params) ? (n.params as Record<string, unknown>) : undefined,
        ignore_errors: typeof n.ignore_errors === "boolean" ? n.ignore_errors : undefined,
      };
    }
    case "loop": {
      if (!("condition" in n)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): loop node requires 'condition'`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      if (!("max_iterations" in n) || typeof n.max_iterations !== "number") {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): loop node requires 'max_iterations' (number)`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      if (!("body" in n) || !isRecord(n.body) || !Array.isArray((n.body as Record<string, unknown>).nodes)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): loop node requires 'body.nodes' (array)`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      const bodyNodes = (n.body as Record<string, unknown>).nodes as unknown[];
      return {
        ...base,
        type: "loop",
        condition: n.condition as string,
        max_iterations: n.max_iterations as number,
        body: {
          nodes: bodyNodes.map((bn, bi) => parseNode(bn, bi)),
        },
      };
    }
    case "transform": {
      if (!("output" in n) || !isRecord(n.output) || Object.keys(n.output as Record<string, unknown>).length === 0) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): transform node requires non-empty 'output' mapping`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      return {
        ...base,
        type: "transform",
        inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
        output: n.output as Record<string, string>,
      };
    }
    case "custom": {
      if (!("tool" in n) || typeof n.tool !== "string" || !n.tool.trim()) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): custom node requires 'tool'`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      const registry = opts?.customRegistry;
      const toolDef = registry?.get(n.tool);
      if (registry && !toolDef) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): custom tool '${n.tool}' not registered`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      if (!n.outputs || !isRecord(n.outputs)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): custom node requires 'outputs' mapping`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      if (toolDef) {
        // produces 含 "*" 表示通配符工具（如通用 slurm 工具），跳过严格校验，
        // outputs key 完全由用户在 YAML 声明，适配任意脚本产物
        const allowsAnyOutput = toolDef.produces.includes("*");
        if (!allowsAnyOutput) {
          const producesSet = new Set(toolDef.produces);
          for (const key of Object.keys(n.outputs as Record<string, unknown>)) {
            if (!producesSet.has(key)) {
              throw new WorkflowError(
                `nodes[${index}] (${n.id}): output '${key}' not declared in tool '${n.tool}' produces list [${toolDef.produces.join(", ")}]`,
                WorkflowErrorCode.INVALID_YAML,
              );
            }
          }
        }
      }
      // 根据 tool kind 判断是否允许/要求 script 字段
      const isSlurmTool = toolDef?.kind === "slurm";

      if (isSlurmTool) {
        // SlurmNode 子类: script 必填
        if (n.script === undefined || n.script === null) {
          throw new WorkflowError(
            `nodes[${index}] (${n.id}): slurm tool '${n.tool}' requires 'script.content'`,
            WorkflowErrorCode.INVALID_YAML,
          );
        }
      } else if (n.script !== undefined && n.script !== null) {
        // 非 SlurmNode 工具: 禁止 script 字段,避免用户误用
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): non-slurm tool '${n.tool}' does not support 'script' field`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      return {
        ...base,
        type: "custom",
        tool: n.tool as string,
        inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
        // 透传 YAML slurm: 字段（partition/cores/memory/walltime/modules 等），
        // 由 custom-executor 注入到 ExecuteContext.slurm，SlurmNode 合并到默认配置
        slurm: parseSlurmConfig(n.slurm),
        script: parseScriptConfig(n.script, n.id as string),
        outputs: parseOutputs(n.outputs),
        foreach: typeof n.foreach === "string" ? n.foreach : undefined,
        maxConcurrent: typeof n.maxConcurrent === "number" ? n.maxConcurrent : undefined,
        continueOnError: typeof n.continueOnError === "boolean" ? n.continueOnError : undefined,
      };
    }
  }
}

/** 解析 outputs 字段为 { pattern, type } 结构 */
function parseOutputs(raw: unknown): Record<string, { pattern: string; type: "file" | "file-list" | "dir" }> {
  if (!isRecord(raw)) return {};
  const result: Record<string, { pattern: string; type: "file" | "file-list" | "dir" }> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isRecord(val)) {
      throw new WorkflowError(
        `outputs.${key}: must be a mapping with 'pattern' and 'type'`,
        WorkflowErrorCode.INVALID_YAML,
      );
    }
    const pattern = typeof val.pattern === "string" ? val.pattern : "";
    const type =
      typeof val.type === "string" && ["file", "file-list", "dir"].includes(val.type)
        ? (val.type as "file" | "file-list" | "dir")
        : "file";
    result[key] = { pattern, type };
  }
  return result;
}

/**
 * 解析 custom 节点的 slurm: 字段为 Partial<SlurmConfig>。
 * 字段全可选，未声明返回 undefined（沿用工具默认资源）。
 * 类型不匹配的字段会被忽略并 warn，避免 YAML 笔误导致整个解析失败。
 */
function parseSlurmConfig(raw: unknown): CustomNodeDef["slurm"] {
  if (!isRecord(raw)) return undefined;
  const result: NonNullable<CustomNodeDef["slurm"]> = {};

  if (typeof raw.partition === "string") result.partition = raw.partition;
  if (typeof raw.cores === "number") {
    result.cores = raw.cores;
  } else if (typeof raw.cores === "string" && raw.cores.trim() !== "") {
    // 宽容处理 YAML 的 "4" 字符串写法
    const parsed = Number.parseInt(raw.cores, 10);
    if (!Number.isNaN(parsed)) result.cores = parsed;
  }
  if (typeof raw.nodes === "number") result.nodes = raw.nodes;
  if (typeof raw.memory === "string") result.memory = raw.memory;
  if (typeof raw.walltime === "string") result.walltime = raw.walltime;
  if (Array.isArray(raw.modules)) {
    result.modules = raw.modules.filter((m): m is string => typeof m === "string");
  }
  if (typeof raw.jobName === "string") result.jobName = raw.jobName;
  if (Array.isArray(raw.extraSBATCH)) {
    result.extraSBATCH = raw.extraSBATCH.filter((m): m is string => typeof m === "string");
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 解析 custom 节点的 script: 字段为 { content, env }。
 * 仅 tool 是 SlurmNode 子类时由 parseNode 调用。
 *
 * 校验:
 * - content 必须是非空字符串,否则抛 INVALID_YAML(含节点 id + 字段路径)
 * - env 若声明必须是 Record<string, string>,value 非字符串时 warn 并跳过(宽容处理)
 * - 字段全缺失时返回 undefined(但 SlurmNode 子类的 parseNode 会要求 content 必填)
 */
function parseScriptConfig(raw: unknown, nodeId: string): CustomNodeDef["script"] {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new WorkflowError(
      `nodes (${nodeId}): 'script' must be a mapping with 'content' and optional 'env'`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }

  // content: 必须是非空字符串(先校验,通过后才初始化 result 以避免占位值)
  if (typeof raw.content !== "string" || !raw.content.trim()) {
    throw new WorkflowError(
      `nodes (${nodeId}): 'script.content' is required and must be a non-empty string`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }
  const result: NonNullable<CustomNodeDef["script"]> = { content: raw.content };

  // env: 可选,必须是 Record<string, string>,value 非字符串时 warn 并跳过
  if (raw.env !== undefined && raw.env !== null) {
    if (!isRecord(raw.env)) {
      throw new WorkflowError(
        `nodes (${nodeId}): 'script.env' must be a mapping of string -> string`,
        WorkflowErrorCode.INVALID_YAML,
      );
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== "string") {
        console.warn(`[yaml-parser] nodes (${nodeId}): script.env['${k}'] is not a string, skipping`);
        continue;
      }
      env[k] = v;
    }
    if (Object.keys(env).length > 0) result.env = env;
  }

  return result;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
