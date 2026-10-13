/**
 * 拓扑构建：compose 文件 → 图（节点 = compose 文件，边 = 结构关系）。
 *
 * 边的四类来源，各自对应一种「Compose 能表达 / 不能表达」的现实：
 *   - include      顶层 include 引入（本仓只有 root → docker/common）
 *   - network      服务接入别的编排创建的 external 网络（跨项目 DNS 的唯一通路，文档 §3）
 *   - service      值里引用了别项目的服务名（跨项目 depends_on 表达不了，只能这样体现；已按网络可达性校验）
 *   - depends_on   同一文件内的服务依赖
 *
 * 口径约定：同属一个 compose 项目（root + 其 include 的文件）之间的引用不画跨项目边——
 * 它们本来就是同一项目内的服务名解析，用 include 边表达即可。
 */

import type { ComposeDependsOn, ComposeDoc, ComposeNetwork } from "./compose-doc";
import { type FeatureFlags, type FeatureState, flagForDirName, flagForProfile, flagState } from "./deploy-config";

export type EdgeKind = "include" | "network" | "service" | "depends_on";

/** 边的端点：文件级关系只有 doc，服务级关系带 service。 */
export type EdgeEnd = { doc: string; service?: string };

export type EdgeEvidence = {
  fromService: string;
  token: string;
  path: string;
  /** 证据所在文件（仓库根相对路径），供 UI 跳转到对应行 */
  file: string;
  line: number;
};

export type TopologyEdge = {
  id: string;
  from: EdgeEnd;
  to: EdgeEnd;
  kind: EdgeKind;
  label: string;
  /** 目标在当前开关下是否可用（profile 未打开的服务 = 依赖实际不成立） */
  satisfied: boolean;
  /** 未满足时给出原因键（如 FENIX_FEATURE_MYSQL） */
  blockedBy?: string;
  evidence: EdgeEvidence[];
  /** 同名服务命中多个编排时列出候选，UI 提示需要人工确认 */
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
  dependsOn: ComposeDependsOn[];
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
  /** root = 顶层编排；base = 被顶层 include 的基础服务；dependency = 独立依赖目录 */
  role: "root" | "base" | "dependency";
  featureFlag: string | null;
  featureState: FeatureState;
  services: TopologyService[];
  networks: ComposeNetwork[];
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
  flags: FeatureFlags;
  warnings: TopologyWarning[];
};

/** 网络名解析：文件内声明的用 name（缺省即 key），未声明的（如 common 里只写服务侧）按 key 处理。 */
function resolvedNetworkName(doc: ComposeDoc, key: string): string {
  const declared = doc.networks.find((network) => network.key === key);
  return declared?.name ?? key;
}

function networkNamesOf(doc: ComposeDoc): Set<string> {
  const names = new Set<string>();
  for (const network of doc.networks) names.add(network.name ?? network.key);
  for (const service of doc.services) {
    for (const key of service.networks) names.add(resolvedNetworkName(doc, key));
  }
  return names;
}

/** 服务名与网络别名索引：名字 → 定义它的 (文件, 服务)。 */
type NameIndex = Map<string, Array<{ doc: ComposeDoc; service: string }>>;

function buildNameIndex(docs: ComposeDoc[]): NameIndex {
  const index: NameIndex = new Map();
  const add = (name: string, doc: ComposeDoc, service: string): void => {
    const bucket = index.get(name) ?? [];
    bucket.push({ doc, service });
    index.set(name, bucket);
  };
  for (const doc of docs) {
    for (const service of doc.services) {
      add(service.name, doc, service.name);
      for (const aliases of Object.values(service.networkAliases)) {
        for (const alias of aliases) add(alias, doc, service.name);
      }
    }
  }
  return index;
}

/** include 闭包：把「顶层 + 它 include 的文件」视为同一个 compose 项目。 */
function buildProjectGroups(docs: ComposeDoc[]): Map<string, string> {
  const known = new Set(docs.map((doc) => doc.id));
  const parent = new Map<string, string>(docs.map((doc) => [doc.id, doc.id]));

  const find = (id: string): string => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current) ?? current;
    return current;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const doc of docs) {
    for (const include of doc.includes) if (known.has(include)) union(doc.id, include);
  }
  return new Map(docs.map((doc) => [doc.id, find(doc.id)]));
}

function serviceState(
  service: { profiles: string[] },
  flags: FeatureFlags,
): { flag: string | null; state: FeatureState } {
  if (service.profiles.length === 0) return { flag: null, state: "enabled" };
  const flag = flagForProfile(service.profiles[0]);
  return { flag, state: flagState(flags, flag) };
}

/** 供 UI 展示与索引用的服务视图（把解析模型裁剪成面板需要的字段）。 */
function toTopologyService(service: ComposeDoc["services"][number], flags: FeatureFlags): TopologyService {
  const { flag, state } = serviceState(service, flags);
  return {
    name: service.name,
    image: service.image,
    dockerfile: service.dockerfile,
    containerName: service.containerName,
    profiles: service.profiles,
    profileFlag: flag,
    state,
    restart: service.restart,
    ports: service.ports,
    networks: service.networks,
    dependsOn: service.dependsOn,
    references: service.references.map((ref) => ({ token: ref.token, path: ref.path, line: ref.line })),
    oneShot: service.oneShot,
    privileged: service.privileged,
    hasHealthcheck: service.hasHealthcheck,
    lineStart: service.lineStart,
    lineEnd: service.lineEnd,
  };
}

export function buildTopology(docs: ComposeDoc[], flags: FeatureFlags, repoRoot: string): Topology {
  const warnings: TopologyWarning[] = [];
  const knownDocs = new Map(docs.map((doc) => [doc.id, doc]));
  const groups = buildProjectGroups(docs);
  const groupNetworks = new Map<string, Set<string>>();
  for (const doc of docs) {
    const group = groups.get(doc.id) ?? doc.id;
    const bucket = groupNetworks.get(group) ?? new Set<string>();
    for (const name of networkNamesOf(doc)) bucket.add(name);
    groupNetworks.set(group, bucket);
  }

  /** 两个文件之间是否存在共享网络（同项目天然可达）。 */
  const reachable = (a: string, b: string): boolean => {
    const groupA = groups.get(a) ?? a;
    const groupB = groups.get(b) ?? b;
    if (groupA === groupB) return true;
    const namesA = groupNetworks.get(groupA) ?? new Set<string>();
    const namesB = groupNetworks.get(groupB) ?? new Set<string>();
    for (const name of namesA) if (namesB.has(name)) return true;
    return false;
  };

  // 网络归属：非 external 声明它的文件即创建者（本仓是顶层 docker-compose.yml 的 fenix-server）。
  const networkOwners = new Map<string, ComposeDoc>();
  for (const doc of docs) {
    for (const network of doc.networks) {
      if (network.external) continue;
      const name = network.name ?? network.key;
      const existing = networkOwners.get(name);
      if (existing && existing.id !== doc.id) {
        warnings.push({ level: "warn", message: `网络 ${name} 被 ${existing.id} 与 ${doc.id} 同时创建`, doc: doc.id });
        continue;
      }
      networkOwners.set(name, doc);
    }
  }

  const nameIndex = buildNameIndex(docs);

  // depends_on 的合法性按 include 闭包判断：docker-compose.yml 的 rcs 依赖 docker/common 的 postgres，
  // 在 Compose 里是同项目服务（顶层 include 合并），只有分开看文件时才会误判成「未定义服务」。
  const projectServiceNames = new Map<string, Set<string>>();
  for (const doc of docs) {
    const group = groups.get(doc.id) ?? doc.id;
    const bucket = projectServiceNames.get(group) ?? new Set<string>();
    for (const service of doc.services) bucket.add(service.name);
    projectServiceNames.set(group, bucket);
  }

  const edges: TopologyEdge[] = [];
  const edgeIds = new Set<string>();
  const pushEdge = (edge: TopologyEdge): void => {
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    edges.push(edge);
  };

  for (const doc of docs) {
    const projectGroup = groups.get(doc.id) ?? doc.id;

    // ① include
    for (const include of doc.includes) {
      if (!knownDocs.has(include)) {
        warnings.push({ level: "warn", message: `${doc.id} include 的目标不存在：${include}`, doc: doc.id });
        continue;
      }
      pushEdge({
        id: `include:${doc.id}->${include}`,
        from: { doc: doc.id },
        to: { doc: include },
        kind: "include",
        label: "include",
        satisfied: true,
        evidence: [],
      });
    }

    // ② 接入 external 网络（含没有服务挂载、但文件级声明了 external 的情况）
    const declaredExternal = doc.networks.filter((network) => network.external);
    const attachedNetworks = new Set<string>();
    for (const service of doc.services) {
      for (const key of service.networks) {
        const name = resolvedNetworkName(doc, key);
        attachedNetworks.add(name);
        const owner = networkOwners.get(name);
        if (!owner || owner.id === doc.id || (groups.get(owner.id) ?? owner.id) === projectGroup) continue;
        pushEdge({
          id: `network:${doc.id}#${service.name}->${owner.id}`,
          from: { doc: doc.id, service: service.name },
          to: { doc: owner.id },
          kind: "network",
          label: name,
          satisfied: true,
          evidence: [],
        });
      }
    }
    for (const network of declaredExternal) {
      const name = network.name ?? network.key;
      if (attachedNetworks.has(name)) continue;
      const owner = networkOwners.get(name);
      if (!owner || owner.id === doc.id || (groups.get(owner.id) ?? owner.id) === projectGroup) continue;
      pushEdge({
        id: `network:${doc.id}->${owner.id}`,
        from: { doc: doc.id },
        to: { doc: owner.id },
        kind: "network",
        label: name,
        satisfied: true,
        evidence: [],
      });
    }

    for (const service of doc.services) {
      // ③ 值里引用了别项目的服务名
      for (const ref of service.references) {
        const candidates = (nameIndex.get(ref.token) ?? []).filter((candidate) => candidate.doc.id !== doc.id);
        if (candidates.length === 0) continue;

        const sameProject = candidates.filter(
          (candidate) => (groups.get(candidate.doc.id) ?? candidate.doc.id) === projectGroup,
        );
        if (sameProject.length > 0) continue; // 同项目内的服务名解析，已由 include / 文件内边表达

        const reachableCandidates = candidates.filter((candidate) => reachable(doc.id, candidate.doc.id));
        if (reachableCandidates.length === 0) {
          warnings.push({
            level: "warn",
            message: `未互通：${doc.id} 的 ${service.name} 引用 ${ref.token}，但候选只在 ${[
              ...new Set(candidates.map((candidate) => candidate.doc.id)),
            ].join(" / ")}，两者没有共享网络`,
            doc: doc.id,
          });
          continue;
        }

        const ambiguous = reachableCandidates.length > 1;
        if (ambiguous) {
          warnings.push({
            level: "warn",
            message: `同名服务 ${ref.token} 命中多个编排：${[...new Set(reachableCandidates.map((c) => c.doc.id))].join(" / ")}`,
            doc: doc.id,
          });
        }

        for (const candidate of reachableCandidates) {
          const target = candidate.doc.services.find((item) => item.name === candidate.service);
          const { flag, state } = serviceState(target ?? { profiles: [] }, flags);
          const blocked = flag !== null && state !== "enabled";
          pushEdge({
            id: `service:${doc.id}#${service.name}->${candidate.doc.id}#${candidate.service}#${ref.token}`,
            from: { doc: doc.id, service: service.name },
            to: { doc: candidate.doc.id, service: candidate.service },
            kind: "service",
            label: ref.token,
            satisfied: !blocked,
            blockedBy: blocked ? (flag ?? undefined) : undefined,
            evidence: [
              { fromService: service.name, token: ref.token, path: ref.path, file: doc.relPath, line: ref.line },
            ],
            ambiguousDocs: ambiguous ? [...new Set(reachableCandidates.map((c) => c.doc.id))] : undefined,
          });
        }
      }

      // ④ 文件内 depends_on（目标可能落在同项目的另一个文件里，如顶层 rcs → common 的 postgres）
      for (const dependency of service.dependsOn) {
        if (!(projectServiceNames.get(projectGroup) ?? new Set<string>()).has(dependency.service)) {
          warnings.push({
            level: "warn",
            message: `${doc.id} 的 ${service.name} depends_on 了未定义的服务 ${dependency.service}`,
            doc: doc.id,
          });
          continue;
        }
        const targetDoc =
          docs.find(
            (item) =>
              (groups.get(item.id) ?? item.id) === projectGroup &&
              item.services.some((s) => s.name === dependency.service),
          ) ?? doc;
        pushEdge({
          id: `depends_on:${doc.id}#${service.name}->${targetDoc.id}#${dependency.service}`,
          from: { doc: doc.id, service: service.name },
          to: { doc: targetDoc.id, service: dependency.service },
          kind: "depends_on",
          label: dependency.condition ?? "depends_on",
          satisfied: true,
          evidence: [],
        });
      }
    }

    if (doc.namedVolumes.length > 0) {
      warnings.push({
        level: "info",
        message: `${doc.id} 声明了命名卷 ${doc.namedVolumes.join(" / ")}（契约 §6.5 要求数据 bind 到交付目录）`,
        doc: doc.id,
      });
    }
    for (const error of doc.parseErrors)
      warnings.push({ level: "warn", message: `${doc.id} YAML 解析告警：${error}`, doc: doc.id });
  }

  const touchedDocs = new Set<string>();
  for (const edge of edges) {
    touchedDocs.add(edge.from.doc);
    touchedDocs.add(edge.to.doc);
  }

  const rootDoc = docs.find((item) => item.dirRel === ".");
  const rootGroup = rootDoc ? (groups.get(rootDoc.id) ?? rootDoc.id) : null;

  /**
   * 依赖目录的 feature 开关：开关与目录一一对应（docker/lib/config.sh），**部署变体**
   * （docker/<name>/<sub>/）沿用其所属目录的开关，不另造 `FENIX_FEATURE_<sub>`。
   */
  const featureFlagOf = (doc: ComposeDoc): string | null => {
    if (doc.dirRel === ".") return null;
    // 被顶层 include 的基础服务（docker/common）不是可开关的依赖目录，不给它造开关名。
    if (rootGroup !== null && (groups.get(doc.id) ?? doc.id) === rootGroup) return null;
    const segments = doc.dirRel.split("/");
    const dependencyDir = segments[1] ?? segments[0];
    return flagForDirName(dependencyDir);
  };

  const topologyDocs: TopologyDoc[] = docs.map((doc) => {
    const dirFeatureFlag = featureFlagOf(doc);
    const group = groups.get(doc.id) ?? doc.id;
    const isRoot = doc.dirRel === ".";
    return {
      id: doc.id,
      label: doc.label,
      relPath: doc.relPath,
      dirRel: doc.dirRel,
      projectName: doc.projectName,
      variant: doc.variant,
      role: isRoot ? "root" : rootGroup === group ? "base" : "dependency",
      featureFlag: dirFeatureFlag,
      featureState: flagState(flags, dirFeatureFlag),
      services: doc.services.map((service) => toTopologyService(service, flags)),
      networks: doc.networks,
      includes: doc.includes,
      namedVolumes: doc.namedVolumes,
      parseErrors: doc.parseErrors,
      lineCount: doc.lineCount,
      isolated: !touchedDocs.has(doc.id),
    };
  });

  for (const doc of topologyDocs) {
    if (doc.isolated && doc.parseErrors.length === 0) {
      warnings.push({
        level: "info",
        message: `${doc.id} 与本机其它编排没有结构关系（独立部署形态，或需要 .env 提供地址）`,
        doc: doc.id,
      });
    }
  }

  return { generatedAt: new Date().toISOString(), repoRoot, docs: topologyDocs, edges, flags, warnings };
}
