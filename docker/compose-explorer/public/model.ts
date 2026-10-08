/**
 * 拓扑 JSON → 渲染模型：节点尺寸、边的聚合、搜索匹配、布局坐标。
 *
 * 聚合口径：编排视图里同一对编排之间的同类关系合成一条边（例如 workflow 有 5 个服务都接入
 * fenix-server，合成一条「共享网络 ×5」），细节保留在 evidence 里，点开面板能看到逐条证据。
 */

import { layeredLayout } from "./layout.ts";
import type { EdgeKind, GraphLink, GraphModel, GraphNode, Topology, TopologyDoc } from "./types.ts";

export type Filters = {
  kinds: Record<EdgeKind, boolean>;
  search: string;
};

export const DEFAULT_FILTERS: Filters = {
  kinds: { include: true, network: true, service: true, depends_on: true },
  search: "",
};

const NODE_WIDTH = 200;
const NODE_HEIGHT = 64;
const PADDING = 56;

/** 节点参与搜索匹配的字段：名字、路径、项目名、服务名与镜像。 */
function docSearchText(doc: TopologyDoc): string {
  return [
    doc.label,
    doc.relPath,
    doc.projectName ?? "",
    ...doc.services.map((service) => `${service.name} ${service.image ?? ""} ${service.dockerfile ?? ""}`),
    ...doc.services.flatMap((service) => service.ports),
  ]
    .join(" ")
    .toLowerCase();
}

export function buildGraph(topology: Topology, filters: Filters): GraphModel {
  const search = filters.search.trim().toLowerCase();
  const docsById = new Map(topology.docs.map((doc) => [doc.id, doc]));

  const nodes: GraphNode[] = topology.docs.map((doc) => {
    const internalDeps = topology.edges.filter(
      (edge) => edge.kind === "depends_on" && edge.from.doc === doc.id && edge.to.doc === doc.id,
    ).length;
    return {
      id: doc.id,
      label: doc.label,
      sublabel: doc.dirRel,
      role: doc.role,
      state: doc.featureState,
      variant: doc.variant,
      internalDeps,
      serviceCount: doc.services.length,
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      matched: search === "" || docSearchText(doc).includes(search),
    };
  });

  type Aggregate = {
    id: string;
    from: string;
    to: string;
    kind: EdgeKind;
    labels: Set<string>;
    satisfied: boolean;
    blockedBy?: string;
    count: number;
    evidence: GraphLink["evidence"];
    ambiguous: boolean;
  };
  const aggregates = new Map<string, Aggregate>();

  for (const edge of topology.edges) {
    if (edge.kind === "depends_on") continue; // 同项目内的依赖：见节点角标与面板，不画边
    if (!filters.kinds[edge.kind]) continue;
    if (edge.from.doc === edge.to.doc) continue;
    if (!docsById.has(edge.from.doc) || !docsById.has(edge.to.doc)) continue;

    const key = `${edge.from.doc}|${edge.to.doc}|${edge.kind}`;
    const aggregate = aggregates.get(key) ?? {
      id: key,
      from: edge.from.doc,
      to: edge.to.doc,
      kind: edge.kind,
      labels: new Set<string>(),
      satisfied: true,
      blockedBy: undefined,
      count: 0,
      evidence: [],
      ambiguous: false,
    };
    aggregate.labels.add(edge.label);
    aggregate.count += 1;
    aggregate.satisfied = aggregate.satisfied && edge.satisfied;
    aggregate.blockedBy = aggregate.blockedBy ?? edge.blockedBy;
    aggregate.ambiguous = aggregate.ambiguous || Boolean(edge.ambiguousDocs);
    if (aggregate.evidence.length < 40) aggregate.evidence.push(...edge.evidence);
    aggregates.set(key, aggregate);
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const links: GraphLink[] = [...aggregates.values()].map((aggregate) => {
    const label = [...aggregate.labels];
    const fromNode = nodesById.get(aggregate.from);
    const toNode = nodesById.get(aggregate.to);
    return {
      id: aggregate.id,
      from: aggregate.from,
      to: aggregate.to,
      kind: aggregate.kind,
      label: label.length > 2 ? `${label.slice(0, 2).join(" / ")} 等 ${label.length} 种` : label.join(" / "),
      satisfied: aggregate.satisfied,
      blockedBy: aggregate.blockedBy,
      count: aggregate.count,
      evidence: aggregate.evidence,
      ambiguous: aggregate.ambiguous,
      matched:
        search === "" ||
        Boolean(fromNode?.matched) ||
        Boolean(toNode?.matched) ||
        label.join(" ").toLowerCase().includes(search),
    };
  });

  const layout = layeredLayout(
    nodes.map((node) => ({ id: node.id, width: node.width, height: node.height, cluster: node.sublabel })),
    links.map((link) => ({ from: link.from, to: link.to })),
  );

  for (const node of nodes) {
    const position = layout.positions.get(node.id);
    node.x = (position?.x ?? 0) + PADDING;
    node.y = (position?.y ?? 0) + PADDING;
  }

  return {
    nodes,
    links,
    width: layout.width + PADDING * 2,
    height: layout.height + PADDING * 2,
  };
}
