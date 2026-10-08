/**
 * 单个 compose 文件的解析结果（协议边界：YAML → 领域模型）。
 *
 * 只解析本工具真正用到的字段：服务、网络、include、profiles、depends_on、端口与值里的 host 引用。
 * 行号来自 YAML CST 的 range，是 UI「点服务 → 高亮文件对应段落」的基础；
 * 服务块起点会向上吞掉紧邻的注释块，让高亮带上本仓每段前的说明注释。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { isMap, isScalar, LineCounter, parseDocument } from "yaml";

import { collectServiceReferences, resolveReferenceLines, type ServiceReference } from "./references";

export type ComposeDependsOn = { service: string; condition?: string };

export type ComposeService = {
  name: string;
  image?: string;
  dockerfile?: string;
  containerName?: string;
  profiles: string[];
  restart?: string;
  ports: string[];
  /** 服务挂载的网络键（缺省即项目默认网络） */
  networks: string[];
  networkAliases: Record<string, string[]>;
  dependsOn: ComposeDependsOn[];
  references: ServiceReference[];
  envFiles: string[];
  volumes: string[];
  privileged: boolean;
  hasHealthcheck: boolean;
  /** 一次性服务（restart: no/none 且不发布端口）：本仓的 init / job 语义 */
  oneShot: boolean;
  lineStart: number;
  lineEnd: number;
};

export type ComposeNetwork = {
  key: string;
  name?: string;
  external: boolean;
  driver?: string;
};

export type ComposeDoc = {
  /** 仓库根相对路径，同时作为图节点 id 与文件 id */
  id: string;
  relPath: string;
  absPath: string;
  /** 所在目录（仓库根相对） */
  dirRel: string;
  /** 展示名：目录名；顶层编排用文件名 */
  label: string;
  projectName?: string;
  /** 是否位于 docker/<x>/<y>/ 下（例如 opensandbox-cluster/deploy 的部署变体） */
  variant: boolean;
  services: ComposeService[];
  networks: ComposeNetwork[];
  /** include 的目标文件（仓库根相对路径） */
  includes: string[];
  /** 顶层 volumes 段声明的命名卷（本仓契约禁止命名卷，用于给出提示） */
  namedVolumes: string[];
  parseErrors: string[];
  lineCount: number;
  text: string;
  lines: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  return [];
}

/** 把 range 转成 1 起的行号；无 range 时返回 0。 */
function lineOf(lineCounter: LineCounter, range: readonly [number, number, number] | null | undefined): number {
  if (!range) return 0;
  return lineCounter.linePos(range[0]).line;
}

/** 向上吞掉紧邻的注释 / 空行，让高亮包含服务前的说明注释。 */
function expandBlockStart(lines: string[], startLine: number): number {
  let line = startLine;
  while (line > 1) {
    const previous = (lines[line - 2] ?? "").trim();
    if (previous === "" || previous.startsWith("#")) {
      line -= 1;
      continue;
    }
    break;
  }
  return line;
}

/** 服务块的行号区间：起点吞注释，终点是下一个服务块（含其注释）的上一行。 */
function computeServiceBlocks(
  lineCounter: LineCounter,
  serviceKeyRanges: Map<string, readonly [number, number, number]>,
  lines: string[],
): Map<string, { start: number; end: number }> {
  const rawStarts = new Map<string, number>();
  for (const [name, range] of serviceKeyRanges)
    rawStarts.set(name, expandBlockStart(lines, lineOf(lineCounter, range)));

  const ordered = [...rawStarts.entries()].sort((a, b) => a[1] - b[1]);
  const blocks = new Map<string, { start: number; end: number }>();
  ordered.forEach(([name, start], index) => {
    const next = ordered[index + 1];
    blocks.set(name, { start, end: next ? next[1] - 1 : lines.length });
  });
  return blocks;
}

function parseService(
  name: string,
  raw: unknown,
  block: { start: number; end: number },
  lines: string[],
): ComposeService {
  const service = asRecord(raw);
  const networks = asRecord(service.networks);
  const networkKeys = Array.isArray(service.networks) ? asStringList(service.networks) : Object.keys(networks);
  const networkAliases: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(networks)) {
    networkAliases[key] = asStringList(asRecord(value).aliases);
  }

  const dependsOnRaw = service.depends_on;
  const dependsOn: ComposeDependsOn[] = Array.isArray(dependsOnRaw)
    ? asStringList(dependsOnRaw).map((item) => ({ service: item }))
    : Object.entries(asRecord(dependsOnRaw)).map(([key, value]) => ({
        service: key,
        condition: typeof asRecord(value).condition === "string" ? String(asRecord(value).condition) : undefined,
      }));

  const build = asRecord(service.build);
  const restartValue =
    typeof service.restart === "string" ? service.restart : service.restart === false ? "no" : undefined;
  const ports = asStringList(service.ports);

  const envFiles = asStringList(service.env_file).concat(
    Array.isArray(service.env_file)
      ? service.env_file
          .map((item) => (typeof asRecord(item).path === "string" ? String(asRecord(item).path) : null))
          .filter((item): item is string => item !== null)
      : [],
  );

  const references = resolveReferenceLines(lines, block, collectServiceReferences(service));

  return {
    name,
    image: typeof service.image === "string" ? service.image : undefined,
    dockerfile: typeof build.dockerfile === "string" ? build.dockerfile : undefined,
    containerName: typeof service.container_name === "string" ? service.container_name : undefined,
    profiles: asStringList(service.profiles),
    restart: restartValue,
    ports,
    networks: networkKeys.length > 0 ? networkKeys : ["default"],
    networkAliases,
    dependsOn,
    references,
    envFiles,
    volumes: asStringList(service.volumes),
    privileged: service.privileged === true,
    hasHealthcheck: service.healthcheck !== undefined,
    oneShot: (restartValue === "no" || restartValue === "none") && ports.length === 0,
    lineStart: block.start,
    lineEnd: block.end,
  };
}

/** 解析一个 compose 文件；解析失败不抛错，返回带 parseErrors 的模型（UI 要能看到坏文件）。 */
export function parseComposeDoc(absPath: string, relPath: string, repoRoot: string): ComposeDoc {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split("\n");
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: false });
  const plain = asRecord(document.toJS({ maxAliasCount: 100 }));

  const serviceKeyRanges = new Map<string, readonly [number, number, number]>();
  const servicesNode = document.get("services", true);
  if (isMap(servicesNode)) {
    for (const item of servicesNode.items) {
      if (isScalar(item.key) && typeof item.key.value === "string" && item.key.range) {
        serviceKeyRanges.set(item.key.value, item.key.range);
      }
    }
  }
  const blocks = computeServiceBlocks(lineCounter, serviceKeyRanges, lines);

  const services: ComposeService[] = [];
  for (const [name, raw] of Object.entries(asRecord(plain.services))) {
    const block = blocks.get(name) ?? { start: 1, end: lines.length };
    services.push(parseService(name, raw, block, lines));
  }
  services.sort((a, b) => a.lineStart - b.lineStart);

  const networks: ComposeNetwork[] = Object.entries(asRecord(plain.networks)).map(([key, value]) => {
    const network = asRecord(value);
    return {
      key,
      name: typeof network.name === "string" ? network.name : undefined,
      external: network.external === true,
      driver: typeof network.driver === "string" ? network.driver : undefined,
    };
  });

  const dirAbs = path.dirname(absPath);
  const includes = asStringList(
    Array.isArray(plain.include)
      ? plain.include.map((item: unknown) => asRecord(item).path ?? item)
      : asRecord(plain.include).path,
  ).map((target) => path.relative(repoRoot, path.resolve(dirAbs, target)).split(path.sep).join("/"));

  // 顶层文件的 path.relative 结果是空串，统一成 "."，让「是否是顶层」只有一种写法。
  const relativeDir = path.relative(repoRoot, dirAbs).split(path.sep).join("/");
  const dirRel = relativeDir === "" ? "." : relativeDir;
  const baseName = path.basename(absPath);

  return {
    id: relPath,
    relPath,
    absPath,
    dirRel,
    label: dirRel === "." ? baseName : path.basename(dirAbs),
    projectName: typeof plain.name === "string" ? plain.name : undefined,
    variant: dirRel.split("/").length > 2,
    services,
    networks,
    includes,
    namedVolumes: Object.keys(asRecord(plain.volumes)),
    parseErrors: document.errors.map((error) => error.message),
    lineCount: lines.length,
    text,
    lines,
  };
}
