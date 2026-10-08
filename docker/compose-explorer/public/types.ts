/**
 * 前端消费的数据形状 + 视图模型。
 *
 * 协议边界：`Topology*` / `File*` 是 `/api/topology`、`/api/files`、`/api/file` 返回结构的**镜像**，
 * 后端字段改动必须同步此处（本工具刻意不跨包引类型，保持能独立跑）。
 * `GraphNode` / `GraphLink` 是仅供渲染使用的视图模型（聚合后的边、算好坐标的节点）。
 */

export type FeatureState = "enabled" | "disabled" | "unset";
export type EdgeKind = "include" | "network" | "service" | "depends_on";
export type DocRole = "root" | "base" | "dependency";

export type EdgeEnd = { doc: string; service?: string };

export type EdgeEvidence = {
  fromService: string;
  token: string;
  path: string;
  file: string;
  line: number;
};

export type TopologyEdge = {
  id: string;
  from: EdgeEnd;
  to: EdgeEnd;
  kind: EdgeKind;
  label: string;
  satisfied: boolean;
  blockedBy?: string;
  evidence: EdgeEvidence[];
  ambiguousDocs?: string[];
};

export type TopologyService = {
  name: string;
  image?: string;
  dockerfile?: string;
  containerName?: string;
  profiles: string[];
  profileFlag: string | null;
  state: FeatureState;
  restart?: string;
  ports: string[];
  networks: string[];
  dependsOn: Array<{ service: string; condition?: string }>;
  references: Array<{ token: string; path: string; line: number }>;
  oneShot: boolean;
  privileged: boolean;
  hasHealthcheck: boolean;
  lineStart: number;
  lineEnd: number;
};

export type TopologyDoc = {
  id: string;
  label: string;
  relPath: string;
  dirRel: string;
  projectName?: string;
  variant: boolean;
  role: DocRole;
  featureFlag: string | null;
  featureState: FeatureState;
  services: TopologyService[];
  networks: Array<{ key: string; name?: string; external: boolean; driver?: string }>;
  includes: string[];
  namedVolumes: string[];
  parseErrors: string[];
  lineCount: number;
  isolated: boolean;
};

export type TopologyWarning = { level: "warn" | "info"; message: string; doc?: string };

export type Topology = {
  generatedAt: string;
  repoRoot: string;
  docs: TopologyDoc[];
  edges: TopologyEdge[];
  flags: { source: string | null; values: Record<string, boolean>; warnings: string[] };
  warnings: TopologyWarning[];
};

export type FileSummary = {
  id: string;
  relPath: string;
  label: string;
  kind: "compose" | "readme" | "env-example" | "dockerfile" | "script" | "config" | "doc";
  group: string | null;
  size: number;
};

export type FileContent = {
  id: string;
  label: string;
  language: string;
  content: string;
  truncated: boolean;
  lineCount: number;
  size: number;
};

/** 渲染节点：一个 compose 文件。 */
export type GraphNode = {
  id: string;
  label: string;
  sublabel: string;
  role: DocRole;
  state: FeatureState;
  variant: boolean;
  /** 同文件内的 depends_on 条数（画成角标，不画成边） */
  internalDeps: number;
  serviceCount: number;
  x: number;
  y: number;
  width: number;
  height: number;
  matched: boolean;
};

/** 渲染边：同一对端点的同类关系已聚合（count 为合并条数）。 */
export type GraphLink = {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
  satisfied: boolean;
  blockedBy?: string;
  count: number;
  evidence: EdgeEvidence[];
  ambiguous: boolean;
  matched: boolean;
};

export type GraphModel = {
  nodes: GraphNode[];
  links: GraphLink[];
  width: number;
  height: number;
};

export type Selection = { kind: "doc"; docId: string } | { kind: "edge"; edgeId: string } | null;
