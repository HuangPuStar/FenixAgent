import yaml from "js-yaml";
import type { Node, Edge } from "@xyflow/react";

export const START_NODE_ID = "__start__";

export interface WfMeta {
  name: string;
  version: string;
  description: string;
  timeout: number | null;
  defaults: { retry: number; timeout: number; shell: string };
  inputs: Record<string, string>;
  env: Record<string, string>;
}

export const defaultMeta: WfMeta = {
  name: "new-workflow",
  version: "1.0",
  description: "",
  timeout: null,
  defaults: { retry: 0, timeout: 300, shell: "bash -c" },
  inputs: {},
  env: {},
};

interface YamlWorkflow {
  name?: string;
  version?: string;
  description?: string;
  timeout?: number;
  defaults?: { retry?: number; timeout?: number; shell?: string };
  inputs?: Record<string, unknown>;
  env?: Record<string, string>;
  nodes?: Record<string, Record<string, unknown>>;
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
    name: doc?.name || "untitled",
    version: doc?.version || "1.0",
    description: doc?.description || "",
    timeout: doc?.timeout ?? null,
    defaults: {
      retry: doc?.defaults?.retry ?? 0,
      timeout: doc?.defaults?.timeout ?? 300,
      shell: doc?.defaults?.shell ?? "bash -c",
    },
    inputs: {},
    env: doc?.env || {},
  };

  const rawNodes = doc?.nodes || {};
  const nodes: Node[] = [createStartNode()];
  const edges: Edge[] = [];
  let idx = 0;

  // 找出没有任何依赖的根节点，连到 start
  const allDepends = new Set<string>();
  for (const raw of Object.values(rawNodes)) {
    const depends = Array.isArray(raw.depends) ? (raw.depends as string[]) : [];
    for (const d of depends) allDepends.add(d);
  }

  for (const [id, raw] of Object.entries(rawNodes)) {
    const type = String(raw.type || "shell");
    const depends = Array.isArray(raw.depends) ? (raw.depends as string[]) : [];

    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k !== "type" && k !== "depends") data[k] = v;
    }

    nodes.push({
      id,
      type,
      position: { x: 240 + idx * 260, y: 100 + (idx % 3) * 100 },
      data,
    });

    // 根节点（无依赖）连到 start
    if (depends.length === 0) {
      edges.push({
        id: `e-${START_NODE_ID}-${id}`,
        source: START_NODE_ID,
        target: id,
        type: "smoothstep",
        animated: false,
      });
    }

    for (const dep of depends) {
      edges.push({
        id: `e-${dep}-${id}`,
        source: dep,
        target: id,
        type: "smoothstep",
        animated: true,
      });
    }

    idx++;
  }

  return { nodes, edges, meta };
}

export function flowToYaml(nodes: Node[], edges: Edge[], meta: WfMeta): string {
  const dependsMap = new Map<string, string[]>();
  for (const edge of edges) {
    // 忽略从 start 节点出发的边（它们表示根节点，depends 为空）
    if (edge.source === START_NODE_ID) continue;
    const deps = dependsMap.get(edge.target) || [];
    if (!deps.includes(edge.source)) deps.push(edge.source);
    dependsMap.set(edge.target, deps);
  }

  const doc: Record<string, unknown> = {
    name: meta.name,
    version: meta.version,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.timeout ? { timeout: meta.timeout } : {}),
    defaults: meta.defaults,
    ...(Object.keys(meta.env).length ? { env: meta.env } : {}),
  };

  const yamlNodes: Record<string, unknown> = {};
  for (const node of nodes) {
    // 排除 start 节点
    if (node.id === START_NODE_ID) continue;

    yamlNodes[node.id] = {
      type: node.type,
      depends: dependsMap.get(node.id) || [],
      ...(node.data as Record<string, unknown>),
    };
  }
  doc.nodes = yamlNodes;

  return yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"' });
}

let nodeCounter = 0;

export function nextNodeId(type: string): string {
  const prefix = type === "shell" ? "shell" : type === "agent" ? "agent" : type === "reference" ? "ref" : "node";
  return `${prefix}_${++nodeCounter}`;
}

export function resetNodeCounter(): void {
  nodeCounter = 0;
}
