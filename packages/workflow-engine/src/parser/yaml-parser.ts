/**
 * YAML 解析器 — 将 workflow.yaml 源码解析为 WorkflowDef
 *
 * 使用 yaml 包（core schema）解析，校验 schema_version、必填字段、节点类型等。
 * 无 depends_on �� depends_on 为空的节点绑定到虚拟起始节点。
 */

import { parse as yamlParse } from "yaml";
import type { CustomNodeRegistry } from "../plugins/registry";
import type { NodeDef, NodeType, WorkflowDef } from "../types/dag";
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
      return {
        ...base,
        type: "custom",
        tool: n.tool as string,
        inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
