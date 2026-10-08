/**
 * compose 文件发现与可查看文件索引。
 *
 * 发现口径与仓库约定一致：顶层 `docker-compose.yml` + `docker/<name>/` + `docker/<name>/<sub>/`
 * （后者是如 opensandbox-cluster/deploy 的部署变体）。文件索引是**白名单**：只有这里登记过的路径才可能被
 * `/api/file` 读到（未登记 = 404），因此不存在「靠 ../ 逃出目录」的读路径。
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { ComposeDoc } from "./compose-doc";
import type { ExplorerConfig } from "./config";

export type ComposeFileRef = { absPath: string; relPath: string };

export type FileKind = "compose" | "readme" | "env-example" | "dockerfile" | "script" | "config" | "doc";

export type FileEntry = {
  /** 仓库根相对路径，同时是稳定 id */
  id: string;
  relPath: string;
  absPath: string;
  label: string;
  kind: FileKind;
  /** 归属的 compose 文件 id（同一交付目录的文件归到该目录的编排下；无归属为 null） */
  group: string | null;
  size: number;
};

export type FileIndex = {
  all: FileEntry[];
  byId: Map<string, FileEntry>;
  byGroup: Map<string, FileEntry[]>;
};

/** 不进入扫描的目录名（运行期数据、依赖、构建产物）。 */
const SKIP_DIR = /^(data|node_modules|dist|build|offline|workspace|workspaces|logs?|\.git|.+_data|.+_logs)$/;
/** 明确排除的文件名：可能含密钥或属运行期状态。 */
const DENY_FILE = /^(\.env|.*\.key|.*\.pem|.*\.crt|.*\.p12|.*credentials.*|id_rsa.*|.*\.log)$/;
/** 允许展示的文件名模式。 */
const ALLOW_FILE =
  /^(Dockerfile(\..+)?|Makefile|docker-compose\.(ya?ml)|compose\.(ya?ml)|\..+\.example|.+\.(ya?ml|md|sh|json|toml|conf|example|txt|sql|py))$/;

const MAX_FILE_BYTES = 512 * 1024;

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

function classify(relPath: string): FileKind {
  const base = path.basename(relPath);
  if (/^(docker-compose|compose)\.ya?ml$/.test(base)) return "compose";
  if (base === "README.md" || base.endsWith(".md")) return "doc";
  if (base.includes(".env.example") || base.endsWith(".example")) return "env-example";
  if (base.startsWith("Dockerfile")) return "dockerfile";
  if (base.endsWith(".sh")) return "script";
  return "config";
}

/** 发现所有 compose 文件（顶层 + 一层依赖目录 + 两层部署变体）。 */
export function discoverComposeFiles(config: ExplorerConfig): ComposeFileRef[] {
  const found = new Map<string, ComposeFileRef>();
  const candidates: string[] = [config.rootComposeFile];

  for (const depth of [1, 2]) {
    const pattern = `${"*/".repeat(depth)}{docker-compose,compose}.{yml,yaml}`;
    const glob = new Bun.Glob(pattern);
    for (const match of glob.scanSync({ cwd: config.dockerDir, onlyFiles: true, dot: false })) {
      candidates.push(path.join(config.dockerDir, match));
    }
  }

  for (const absPath of candidates) {
    const relPath = toPosix(path.relative(config.repoRoot, absPath));
    // 工具自身目录不参与编排发现。
    if (relPath.startsWith("docker/compose-explorer/")) continue;
    try {
      if (!statSync(absPath).isFile()) continue;
    } catch {
      continue;
    }
    found.set(relPath, { absPath, relPath });
  }

  return [...found.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function walkDir(dir: string, config: ExplorerConfig, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const absPath = path.join(dir, entry);
    if (absPath.startsWith(path.join(config.dockerDir, "compose-explorer"))) continue;
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absPath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (SKIP_DIR.test(entry)) continue;
      walkDir(absPath, config, out);
      continue;
    }
    if (!stats.isFile()) continue;
    if (DENY_FILE.test(entry) || !ALLOW_FILE.test(entry)) continue;
    if (stats.size > MAX_FILE_BYTES) continue;
    out.push(absPath);
  }
}

/**
 * 建立文件索引：docker/ 下白名单文件 + config.extraFiles（顶层 compose、文档、部署入口脚本）。
 * group 取「包含该文件的最长 compose 目录」，让面板能把文件挂到对应节点上。
 */
export function buildFileIndex(config: ExplorerConfig, docs: ComposeDoc[]): FileIndex {
  const paths: string[] = [];
  walkDir(config.dockerDir, config, paths);
  paths.push(
    config.rootComposeFile,
    path.join(config.repoRoot, "Dockerfile"),
    path.join(config.repoRoot, ".env.example"),
  );
  paths.push(...config.extraFiles);

  const docDirs = docs
    .map((doc) => ({ id: doc.id, dirRel: doc.dirRel }))
    .sort((a, b) => b.dirRel.length - a.dirRel.length);

  const all: FileEntry[] = [];
  const seen = new Set<string>();
  for (const absPath of paths) {
    const relPath = toPosix(path.relative(config.repoRoot, absPath));
    if (seen.has(relPath) || relPath.startsWith("..")) continue;
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absPath);
    } catch {
      continue;
    }
    if (!stats.isFile() || DENY_FILE.test(path.basename(relPath))) continue;
    seen.add(relPath);

    const group = docDirs.find((doc) => relPath.startsWith(`${doc.dirRel}/`) || doc.dirRel === ".")?.id ?? null;
    all.push({
      id: relPath,
      relPath,
      absPath,
      label: relPath,
      kind: classify(relPath),
      group,
      size: stats.size,
    });
  }

  all.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const byGroup = new Map<string, FileEntry[]>();
  for (const entry of all) {
    const key = entry.group ?? "docker";
    const bucket = byGroup.get(key) ?? [];
    bucket.push(entry);
    byGroup.set(key, bucket);
  }

  return { all, byId: new Map(all.map((entry) => [entry.id, entry])), byGroup };
}
