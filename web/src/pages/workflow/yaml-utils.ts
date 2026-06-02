import type { Edge, Node } from "@xyflow/react";
import yaml from "js-yaml";

export const START_NODE_ID = "__start__";

export interface WfMeta {
  schema_version: string;
  name: string;
  description: string;
  timeout: number;
  params: Record<string, unknown>;
  secrets: string[];
}

export const defaultMeta: WfMeta = {
  schema_version: "1",
  name: "new-workflow",
  description: "",
  timeout: 300,
  params: {},
  secrets: [],
};

interface YamlNode {
  id: string;
  type: string;
  depends_on?: string[];
  [key: string]: unknown;
}

interface YamlWorkflow {
  schema_version?: string;
  name?: string;
  description?: string;
  timeout?: number;
  params?: Record<string, unknown>;
  secrets?: string[];
  nodes?: YamlNode[];
}

export function createStartNode(): Node {
  return {
    id: START_NODE_ID,
    type: "start",
    position: { x: 40, y: 200 },
    data: {},
    deletable: false,
  };
}

export function yamlToFlow(yamlStr: string): { nodes: Node[]; edges: Edge[]; meta: WfMeta } {
  const doc = yaml.load(yamlStr) as YamlWorkflow | undefined;

  const meta: WfMeta = {
    schema_version: doc?.schema_version || "1",
    name: doc?.name || "untitled",
    description: doc?.description || "",
    timeout: doc?.timeout ?? 300,
    params: doc?.params || {},
    secrets: doc?.secrets || [],
  };

  const rawNodes = doc?.nodes || [];
  const nodes: Node[] = [createStartNode()];
  const edges: Edge[] = [];

  rawNodes.forEach((raw, idx) => {
    const type = raw.type || "shell";
    const depends = raw.depends_on || [];

    // 将除 id/type/depends_on 之外的字段存入 node.data
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k !== "id" && k !== "type" && k !== "depends_on") data[k] = v;
    }

    nodes.push({
      id: raw.id,
      type,
      position: { x: 100 + (idx % 3) * 200, y: 80 + idx * 100 },
      data,
    });

    // 根节点（无 depends_on）连到 start
    if (depends.length === 0) {
      edges.push({
        id: `logic-${START_NODE_ID}-${raw.id}`,
        source: START_NODE_ID,
        target: raw.id,
        type: "logic",
        data: { hasCondition: false },
      });
    }

    for (const dep of depends) {
      const condition = data.condition;
      edges.push({
        id: `logic-${dep}-${raw.id}`,
        source: dep,
        target: raw.id,
        type: "logic",
        data: { hasCondition: typeof condition === "string" && condition.length > 0 },
      });
    }
  });

  // 注入 _outputFields 到被引用的节点
  const dataFlowEdges = parseDataFlowEdges(nodes);
  const outputFieldsMap = new Map<string, Set<string>>();
  for (const df of dataFlowEdges) {
    let set = outputFieldsMap.get(df.sourceNodeId);
    if (!set) {
      set = new Set();
      outputFieldsMap.set(df.sourceNodeId, set);
    }
    set.add(df.sourceField);
  }
  for (const node of nodes) {
    const fields = outputFieldsMap.get(node.id);
    if (fields) {
      node.data = { ...node.data, _outputFields: [...fields] };
    }
  }

  // 解析参数指引边
  for (const df of dataFlowEdges) {
    edges.push({
      id: `data-${df.sourceNodeId}.${df.sourceField}-${df.targetNodeId}.${df.targetParam}`,
      source: df.sourceNodeId,
      target: df.targetNodeId,
      sourceHandle: "data-out",
      targetHandle: "data-in",
      type: "dataFlow",
      data: {
        sourceField: df.sourceField,
        targetParam: df.targetParam,
      },
    });
  }

  return { nodes, edges, meta };
}

export function flowToYaml(nodes: Node[], edges: Edge[], meta: WfMeta): string {
  const dependsMap = new Map<string, string[]>();
  for (const edge of edges) {
    // 只处理逻辑边，跳过参数指引边
    if (edge.type === "dataFlow") continue;
    if (edge.source === START_NODE_ID) continue;
    const deps = dependsMap.get(edge.target) || [];
    if (!deps.includes(edge.source)) deps.push(edge.source);
    dependsMap.set(edge.target, deps);
  }

  const doc: Record<string, unknown> = {
    schema_version: meta.schema_version || "1",
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    timeout: meta.timeout,
    ...(Object.keys(meta.params).length ? { params: meta.params } : {}),
    ...(meta.secrets.length ? { secrets: meta.secrets } : {}),
  };

  const yamlNodes: Record<string, unknown>[] = [];
  for (const node of nodes) {
    if (node.id === START_NODE_ID) continue;

    const entry: Record<string, unknown> = {
      id: node.id,
      type: node.type,
    };

    const depends = dependsMap.get(node.id);
    if (depends && depends.length > 0) {
      entry.depends_on = depends;
    }

    // 合并 node.data 中的非空字段（跳过 _ 开头的内部运行时字段）
    const data = node.data as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith("_")) continue;
      if (v !== undefined && v !== null && v !== "") {
        entry[k] = v;
      }
    }

    yamlNodes.push(entry);
  }
  doc.nodes = yamlNodes;

  return yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"' });
}

let nodeCounter = 0;

const TYPE_PREFIXES: Record<string, string> = {
  shell: "shell",
  python: "python",
  agent: "agent",
  api: "api",
  audit: "audit",
  workflow: "wf",
  loop: "loop",
};

export function nextNodeId(type: string): string {
  const prefix = TYPE_PREFIXES[type] || "node";
  return `${prefix}_${++nodeCounter}`;
}

export function resetNodeCounter(): void {
  nodeCounter = 0;
}

/** 参数指引边数据 */
export interface DataFlowEdgeInfo {
  sourceNodeId: string;
  sourceField: string;
  targetNodeId: string;
  targetParam: string;
}

/** 从节点列表的 inputs 中解析出参数指引边 */
export function parseDataFlowEdges(nodes: Array<{ id: string; data: Record<string, unknown> }>): DataFlowEdgeInfo[] {
  const result: DataFlowEdgeInfo[] = [];
  for (const node of nodes) {
    if (node.id === START_NODE_ID) continue;
    const inputs = node.data.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const [paramName, expr] of Object.entries(inputs as Record<string, string>)) {
      if (typeof expr !== "string") continue;
      const match = expr.match(/^nodes\.([a-zA-Z0-9_-]+)\.(.+)$/);
      if (!match) continue;
      result.push({
        sourceNodeId: match[1],
        sourceField: match[2],
        targetNodeId: node.id,
        targetParam: paramName,
      });
    }
  }
  return result;
}
