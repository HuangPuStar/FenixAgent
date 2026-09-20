// web/__tests__/value-import-graph.ts
// 值导入图遍历器（守卫的**工具**侧，策略与断言在同目录的 memory-browser-surface.test.ts）。
//
// 为什么需要它：浏览器 bundle 的崩溃点不在本包源码里，而在「入口 → … → 某个包外文件」这条链上。
// 2026-08-17 事故的形态是 `@fenix/<pkg>/<subpath>` 把 node 内建拖进前端 bundle，而只记一条
// 「外部说明符」的静态检查对它完全无感（CLAUDE.md YJS 不变量 11）。因此本遍历器**递归进入**
// `@fenix/<pkg>[/<subpath>]`：经对方 `package.json` 的 `exports` 解析到真实源文件，再沿它继续走。
// 只有明确列在调用方白名单里的浏览器安全外部依赖才允许停在图外。
//
// 边界与取舍：
//   - 只沿**值绑定**递归（`import type` 与纯类型命名导入在编译期擦除，不进 bundle）；
//   - 只认 `exports` 出口，不猜目录：解析不到就是违规，避免「测试以为走了 A 文件、构建取了 B 文件」；
//   - `.json` / `.css` 等非代码资源是叶子（它们不可能再导入模块），不入队也不算外部依赖；
//   - workspace 包索引以根 `package.json` 的 workspaces 声明为唯一来源。口径与
//     `scripts/lib/workspace-packages.ts` 一致，但**刻意不 import 它**：守卫属于本包，不能依赖仓库根
//     `scripts/`（包单独检出或独立构建时那里不存在）；口径漂移会被两侧测试同时暴露。
//
// 本文件位于 `__tests__/` 下且不被 `web/index.ts` 引用，既不会进入浏览器 bundle，也不会被 bun test
// 当成测试文件加载（只会被同目录的守卫 import）。

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

/** 本守卫所在的 web contribution 根（`web/`）。 */
export const WEB_ROOT = resolve(import.meta.dir, "..");

/**
 * 仓库根：从 web 根向上找到第一个声明了 `workspaces` 的 `package.json`。
 *
 * 不用写死层数（`../../..`）是因为包目录层级在重构中会变（`packages/<group>/<pkg>` 可能被压平），
 * 而「谁声明了 workspaces」是仓库根的稳定特征；找不到就抛错，不静默退化成空图。
 */
function findProjectRoot(from: string): string {
  let directory = from;
  for (;;) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { workspaces?: unknown };
      if (manifest.workspaces !== undefined) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`未找到声明 workspaces 的 package.json：${from} 上溯到文件系统根`);
    directory = parent;
  }
}

/** 仓库根目录（`package.json` 的 workspaces 声明所在处）。 */
export const PROJECT_ROOT = findProjectRoot(WEB_ROOT);

/** 仓库相对 POSIX 路径（诊断信息里不出现平台分隔符）。 */
export function repoPath(file: string): string {
  return relative(PROJECT_ROOT, file).split(sep).join("/");
}

/** 去掉 // 与块注释（注释里会写出各种说明符字样，必须先剥离再匹配，否则字符串匹配会误报） */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: '"' | "'" | "`" | null = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char === "\\" ? "\\" : "";
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      out += char;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

interface Clause {
  /** import/export 子句（default / namespace / named 列表原文），无则视为副作用导入 */
  clause: string | null;
  /** import type / export type 声明，编译期擦除 */
  typeOnly: boolean;
  specifier: string;
}

/** 提取一条语句的模块说明符（import/export ... from "spec"、副作用 import "spec"、动态 import()） */
function extractStatements(code: string): Clause[] {
  const clauses: Clause[] = [];
  const fromRe = /\b(import|export)\s+(type\s+)?([\s\S]*?)?\s*from\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(fromRe)) {
    clauses.push({ clause: match[3] ?? null, typeOnly: Boolean(match[2]), specifier: match[4] });
  }
  const sideEffectRe = /(?:^|[\s;])import\s*["']([^"']+)["']/gm;
  for (const match of code.matchAll(sideEffectRe)) {
    clauses.push({ clause: null, typeOnly: false, specifier: match[1] });
  }
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of code.matchAll(dynamicRe)) {
    clauses.push({ clause: null, typeOnly: false, specifier: match[1] });
  }
  return clauses;
}

/** 子句是否含值绑定：default / namespace / named 列表中剔除 `type X` 后仍有剩余 */
function hasValueBinding(clause: string | null): boolean {
  if (!clause) return true; // 副作用导入或动态 import：一律按值处理
  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch) {
    const values = braceMatch[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !/^type\s/.test(entry));
    if (values.length > 0) return true;
  }
  const braceless = clause
    .replace(/\{[^}]*\}/g, "")
    .replace(/,/g, " ")
    .trim();
  return braceless.length > 0;
}

/** 可继续遍历的代码扩展名；其余（`.json` / `.css` / `.svg` …）是叶子资源，不可能再导入模块 */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** 一条说明符的解析结果：`file` 是递归入口，`asset` / `external` 是叶子，`violation` 即违规。 */
export type Resolution =
  | { kind: "file"; file: string; scope: "internal" | "cross-package" }
  | { kind: "asset" }
  | { kind: "external"; root: string }
  | { kind: "violation"; detail: string };

/** 图里一条引用：发出它的文件 + 说明符 + 解析结果（分类断言与失败定位都用它）。 */
export type GraphReference = { from: string; specifier: string } & Resolution;

/** 遍历结果。 */
export interface ValueGraph {
  /** 全部到达文件（含入口与经 exports 进入的包外文件）。 */
  files: string[];
  /** 全部发射出的引用及其解析结果。 */
  references: GraphReference[];
}

/** workspace 内一个已声明 `package.json` 的包。 */
export interface WorkspacePackage {
  name: string;
  /** 仓库相对 POSIX 目录，如 `packages/resources/sandbox`。 */
  directory: string;
  exports: Record<string, unknown>;
}

/**
 * 以根 `package.json` 的 workspaces 声明为唯一来源，建立「包名 → 目录 + exports」索引。
 *
 * 用根声明而不是 `node_modules/@fenix/*` 软链：软链只在 `bun install` 之后存在，且同一目录可能挂多个
 * 别名；包名才是 `exports` 契约的粒度。
 */
export function loadWorkspacePackages(): Map<string, WorkspacePackage> {
  const rootManifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
    workspaces?: unknown;
  };
  const globs = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces.filter((glob): glob is string => typeof glob === "string")
    : [];

  const directories = new Set<string>();
  for (const glob of globs) {
    for (const match of new Bun.Glob(glob).scanSync({ cwd: PROJECT_ROOT, onlyFiles: false })) {
      directories.add(match.split(sep).join("/"));
    }
  }

  const packages = new Map<string, WorkspacePackage>();
  for (const directory of directories) {
    const manifestPath = join(PROJECT_ROOT, directory, "package.json");
    // 分组目录（如 `packages/resources`）没有 manifest，不构成 workspace 包。
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; exports?: unknown };
    if (typeof manifest.name !== "string") continue;
    packages.set(manifest.name, {
      name: manifest.name,
      directory,
      exports: (manifest.exports ?? {}) as Record<string, unknown>,
    });
  }
  return packages;
}

/** 最长前缀匹配：`@fenix/chat-channel/server` → 包 `@fenix/chat-channel` + 子路径 `server`。 */
function matchWorkspacePackage(
  packages: ReadonlyMap<string, WorkspacePackage>,
  specifier: string,
): { pkg: WorkspacePackage; subpath: string } | null {
  const segments = specifier.split("/");
  for (let end = segments.length; end > 0; end -= 1) {
    const name = segments.slice(0, end).join("/");
    const pkg = packages.get(name);
    if (pkg) return { pkg, subpath: segments.slice(end).join("/") };
  }
  return null;
}

/**
 * 取 exports 条目的目标文件：条目是字符串，或本仓统一的 `{ types, default }` 形态。
 *
 * 只认 `default`（运行时入口）；`types` 指向 `.d.ts`，浏览器构建取的不是它。条件导出等无法判读的
 * 形态一律当作「无目标」上报违规——宁可显式报错，也不要静默取错文件。
 */
function exportTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    if (typeof record.default === "string") return record.default;
  }
  return null;
}

/** 外部说明符的包根：`@scope/name` 取两段，其余取首段；`node:fs` 原样保留 */
function packageRootOf(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier.split("/")[0];
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/**
 * 把磁盘路径收敛成解析结果：代码文件是递归入口，已存在的非代码资源是叶子，
 * 其余算违规——解析不到在浏览器里就是构建失败或静默的空模块，两种都不该放过。
 */
function resolvePathSpecifier(base: string, scope: "internal" | "cross-package", origin: string): Resolution {
  const extension = extname(base);
  if (extension.length > 0 && !CODE_EXTENSIONS.has(extension)) {
    return existsSync(base)
      ? { kind: "asset" }
      : { kind: "violation", detail: `${origin} 指向的资源不存在：${repoPath(base)}` };
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return { kind: "file", file: candidate, scope };
  }
  return { kind: "violation", detail: `${origin} 解析不到实现文件：${repoPath(base)}` };
}

/** 说明符解析：相对说明符按文件系统解析；裸说明符先试 workspace 包的 exports，再退回外部依赖。 */
function resolveSpecifier(
  packages: ReadonlyMap<string, WorkspacePackage>,
  fromFile: string,
  specifier: string,
): Resolution {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(fromFile), specifier);
    return resolvePathSpecifier(base, "internal", `相对说明符 ${specifier}`);
  }
  if (specifier.startsWith("node:")) return { kind: "external", root: packageRootOf(specifier) };
  const hit = matchWorkspacePackage(packages, specifier);
  if (!hit) return { kind: "external", root: packageRootOf(specifier) };
  const key = hit.subpath.length > 0 ? `./${hit.subpath}` : ".";
  if (hit.pkg.exports[key] === undefined) {
    return { kind: "violation", detail: `${hit.pkg.name} 的 exports 未声明 ${key}` };
  }
  const target = exportTarget(hit.pkg.exports[key]);
  if (target === null) {
    return {
      kind: "violation",
      detail: `${hit.pkg.name} 的 exports ${key} 没有可解析的运行时目标（只认字符串或 default）`,
    };
  }
  return resolvePathSpecifier(
    resolve(PROJECT_ROOT, hit.pkg.directory, target),
    "cross-package",
    `${hit.pkg.name} 的 exports ${key}`,
  );
}

/**
 * 走 `entry` 的值导入图；`seedSpecifiers` 是负例注入（按「入口 import 了它」处理），真实断言不传。
 *
 * 负例注入而不落 fixture 文件：守卫要能拦住真实的 `@fenix/<pkg>/server` 子路径，用真出口比用自造的
 * 假模块更能证明拦截能力（假模块只能证明字符串不匹配）。
 */
export function walkValueGraph(entry: string, seedSpecifiers: readonly string[] = []): ValueGraph {
  const packages = loadWorkspacePackages();
  const files = new Set<string>([entry]);
  const queue: string[] = [entry];
  const references: GraphReference[] = [];
  const trace = (from: string, specifier: string): void => {
    const resolution = resolveSpecifier(packages, from, specifier);
    references.push({ from, specifier, ...resolution });
    if (resolution.kind !== "file" || files.has(resolution.file)) return;
    files.add(resolution.file);
    queue.push(resolution.file);
  };

  for (const specifier of seedSpecifiers) trace(entry, specifier);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const statement of extractStatements(code)) {
      if (statement.typeOnly || !hasValueBinding(statement.clause)) continue;
      trace(file, statement.specifier);
    }
  }
  return { files: [...files], references };
}
