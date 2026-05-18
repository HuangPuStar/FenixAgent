import yaml from "js-yaml";
import type { Node, Edge } from "@xyflow/react";

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
      position: { x: 240 + idx * 260, y: 100 + (idx % 3) * 100 },
      data,
    });

    // 根节点（无 depends_on）连到 start
    if (depends.length === 0) {
      edges.push({
        id: `e-${START_NODE_ID}-${raw.id}`,
        source: START_NODE_ID,
        target: raw.id,
        type: "smoothstep",
        animated: false,
      });
    }

    for (const dep of depends) {
      edges.push({
        id: `e-${dep}-${raw.id}`,
        source: dep,
        target: raw.id,
        type: "smoothstep",
        animated: true,
      });
    }
  });

  return { nodes, edges, meta };
}

export function flowToYaml(nodes: Node[], edges: Edge[], meta: WfMeta): string {
  const dependsMap = new Map<string, string[]>();
  for (const edge of edges) {
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

    // 合并 node.data 中的非空字段
    const data = node.data as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) {
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
