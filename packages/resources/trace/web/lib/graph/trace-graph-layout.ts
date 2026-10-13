/**
 * 调用图模型构建（移植自 langfuse-lite 的 `shared/components/observation-trace-graph-layout.ts`）。
 *
 * 移植差异：
 * 1. `Observation` → {@link TraceObservation}；类型归类改用 `observationKind()`，与角标共用同一判据，
 *    避免「图上算作事件点、角标却当普通 span」这类双份规则。
 * 2. `label` 改为可空：观测可能没有名字，而本文件是纯函数、不持有 i18n 文案，兜底文案交给渲染层。
 *
 * 设计意图（沿用参考实现）：不引入可变状态、不改写 API 观测，只把一次 trace 的观测投影成「Git log 式」的
 * 事件序列——只有 generation/tool 是事件点，其余 span 只用于桥接祖先关系；每个 subagent 占一条稳定泳道，
 * 泳道**不复用**，于是刷新与重取不会让分支身份漂移。已记录 `endTime` 的同步分支才生成 join，后台分支
 * 不隐含汇合（后台任务可能比父级活得更久）。
 */
import { observationKind, type TraceObservation } from "../observation-types";
import { isBackgroundSubagent, isGraphSubagent } from "./trace-graph-semantics";

/** 行代表事件；fork/join 行保留被隐藏的 AGENT 控制流。 */
export type TraceGraphNode = {
  id: string;
  observation: TraceObservation | null;
  kind: "generation" | "tool" | "fork" | "join";
  lane: number;
  parentLane?: number;
  branchId: string;
  timestamp: number;
  /** 观测名；缺名为 null，由渲染层用 `t()` 兜底。 */
  label: string | null;
  background: boolean;
};

export type TraceGraphEdge = {
  id: string;
  from: { row: number; lane: number };
  to: { row: number; lane: number };
  kind: "sequence" | "fork" | "join";
  background: boolean;
  lane: number;
};

export type TraceGraphModel = {
  nodes: TraceGraphNode[];
  edges: TraceGraphEdge[];
  laneCount: number;
  hiddenCount: number;
  branchCount: number;
  startTime: number;
};

type Branch = {
  observation: TraceObservation;
  lane: number;
  parentId: string | null;
  depth: number;
  background: boolean;
  start: number;
  last: number;
  end: number | null;
};

const MAIN_BRANCH_ID = "__main__";

function time(value: string | null): number | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** 被隐藏的 span 只用于桥接祖先：缺失父级或成环都退回主线。 */
function parentBranch(observation: TraceObservation, byId: ReadonlyMap<string, TraceObservation>): string | null {
  const seen = new Set([observation.id]);
  let parentId = observation.parentObservationId;
  let nearest: string | null = null;
  while (parentId) {
    if (seen.has(parentId)) return null;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (nearest === null && isGraphSubagent(parent)) nearest = parent.id;
    parentId = parent.parentObservationId;
  }
  return nearest;
}

/**
 * 构建确定性的 Git-log 投影，不改写 API 观测。
 * 只有 generation/tool 是事件点；每个 subagent 占一条稳定泳道，首版不复用泳道以保住分支身份。
 */
export function buildTraceGraph(observations: TraceObservation[]): TraceGraphModel {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const unique = [...byId.values()];
  const validStarts = unique.flatMap((observation) => {
    const value = time(observation.startTime);
    return value === null ? [] : [value];
  });
  const startTime = validStarts.length ? Math.min(...validStarts) : 0;
  const starts = new Map(unique.map((o) => [o.id, time(o.startTime) ?? startTime]));
  // 稳定排序让同一时刻的事件保持摄取顺序。
  const ordered = unique.slice().sort((a, b) => starts.get(a.id)! - starts.get(b.id)!);
  const branches = new Map<string, Branch>();
  for (const observation of ordered) {
    if (!isGraphSubagent(observation)) continue;
    const start = starts.get(observation.id)!;
    branches.set(observation.id, {
      observation,
      lane: branches.size + 1,
      parentId: parentBranch(observation, byId),
      depth: 1,
      background: isBackgroundSubagent(observation, byId),
      start,
      last: start,
      end: time(observation.endTime),
    });
  }
  for (const branch of branches.values()) {
    let parent = branch.parentId ? branches.get(branch.parentId) : undefined;
    while (parent) {
      branch.depth++;
      parent = parent.parentId ? branches.get(parent.parentId) : undefined;
    }
  }

  const nodes: TraceGraphNode[] = [];
  for (const observation of ordered) {
    const kind = observationKind(observation.type);
    if (kind === "other") continue;
    const branchId = parentBranch(observation, byId);
    const branch = branchId ? branches.get(branchId) : undefined;
    const timestamp = starts.get(observation.id)!;
    if (branch) {
      branch.start = Math.min(branch.start, timestamp);
      branch.last = Math.max(branch.last, timestamp);
    }
    nodes.push({
      id: observation.id,
      observation,
      kind,
      lane: branch?.lane ?? 0,
      branchId: branch?.observation.id ?? MAIN_BRANCH_ID,
      timestamp,
      label: observation.name,
      background: branch?.background ?? false,
    });
  }

  // 时钟偏移不能让子节点排到自己的 fork 之前或 join 之后。
  // 后台子节点可能比父级活得更久，因此不推迟父级的 join。
  const deepestFirst = [...branches.values()].sort((a, b) => b.depth - a.depth);
  for (const branch of deepestFirst) {
    if (branch.end !== null) branch.end = Math.max(branch.end, branch.last, branch.start);
    const parent = branch.parentId ? branches.get(branch.parentId) : undefined;
    if (parent) {
      parent.start = Math.min(parent.start, branch.start);
      parent.last = Math.max(
        parent.last,
        branch.start,
        !branch.background && branch.end !== null ? branch.end : branch.start,
      );
    }
  }
  for (const branch of branches.values()) {
    const parentLane = branch.parentId ? (branches.get(branch.parentId)?.lane ?? 0) : 0;
    const base = {
      observation: branch.observation,
      branchId: branch.observation.id,
      label: branch.observation.name,
      background: branch.background,
      parentLane,
    };
    nodes.push({
      ...base,
      id: `fork:${branch.observation.id}`,
      kind: "fork",
      lane: branch.lane,
      timestamp: branch.start,
    });
    if (!branch.background && branch.end !== null) {
      nodes.push({
        ...base,
        id: `join:${branch.observation.id}`,
        kind: "join",
        lane: parentLane,
        timestamp: branch.end,
      });
    }
  }
  const priority = (node: TraceGraphNode) => {
    const depth = branches.get(node.branchId)?.depth ?? 0;
    if (node.kind === "fork") return -100000 + depth;
    if (node.kind === "join") return 100000 - depth;
    return 0;
  };
  nodes.sort((a, b) => a.timestamp - b.timestamp || priority(a) - priority(b));

  return {
    nodes,
    edges: buildEdges(nodes, branches),
    laneCount: branches.size + 1,
    hiddenCount: unique.filter((o) => observationKind(o.type) === "other" && !isGraphSubagent(o)).length,
    branchCount: branches.size,
    startTime,
  };
}

function buildEdges(nodes: TraceGraphNode[], branches: ReadonlyMap<string, Branch>): TraceGraphEdge[] {
  const edges: TraceGraphEdge[] = [];
  const last = new Map<number, { row: number; lane: number }>();
  const connect = (
    from: TraceGraphEdge["from"],
    to: TraceGraphEdge["to"],
    kind: TraceGraphEdge["kind"],
    lane: number,
    background = false,
  ) => {
    if (from.row === to.row && from.lane === to.lane) return;
    edges.push({ id: `edge:${edges.length}`, from, to, kind, lane, background });
  };
  const advance = (point: TraceGraphEdge["to"]) => {
    const previous = last.get(point.lane);
    if (previous) connect(previous, point, "sequence", point.lane);
    last.set(point.lane, point);
  };
  nodes.forEach((node, row) => {
    const point = { row, lane: node.lane };
    if (node.kind === "fork") {
      const parentPoint = { row, lane: node.parentLane ?? 0 };
      const source = last.get(parentPoint.lane) ?? parentPoint;
      connect(source, point, "fork", node.lane, node.background);
      advance(parentPoint);
      last.set(node.lane, point);
    } else if (node.kind === "join") {
      const branchLane = branches.get(node.branchId)?.lane;
      const source = branchLane === undefined ? undefined : last.get(branchLane);
      if (source) connect(source, point, "join", branchLane ?? node.lane);
      advance(point);
    } else {
      advance(point);
    }
  });
  return edges;
}
