/**
 * 变更影响范围的测试判定：给定「本次改动涉及哪些路径」，算出应该跑哪些测试批次。
 *
 * **服务对象**：`scripts/fastcheck.ts`（agent 完成单任务后的快检）。precheck 是预发布全量门禁，不用它。
 *
 * **判定口径**（保守优先，宁可多跑不可漏跑）：
 * - 宿主代码：`apps/server/**`、`db/**`、`scripts/**` → 宿主测试批；`apps/web/**` → web 测试批。
 * - 包代码：改动落在哪个包目录 → 该包整体测试（包内测试目录形态不统一，`src/__tests__`、
 *   `src/server/__tests__`、`src/plugins/__tests__` 都有，故按包目录整体跑）；再沿**反向依赖**把
 *   消费方的包测试一并纳入——改 `@fenix/chat-channel` 会让 `@fenix/agent-runtime` 的测试变红，
 *   只跑前者等于漏检。
 * - 共享契约（根 `package.json`、锁文件、`tsconfig*.json`、`biome.json`、`drizzle.config.ts`）：
 *   映射关系不可判定，保守跑**全量三批**。
 * - 其余路径（文档、e2e、部署模板、未知根文件）：不影响单测，跳过并打印说明。
 *
 * `packages/platform/platform-sdk` 是宿主测试批的组成部分（见 `check-gates.ts` 的批次口径），改动它只
 * 触发宿主批，不额外跑一次包批。
 *
 * **已知边界**（刻意不做，代价与移除条件一并登记）：反向依赖闭包**只覆盖包与包之间**，不含
 * `apps/server` / `apps/web` 这两个宿主消费方。若把宿主纳入闭包，几乎任何包改动都会拉上 18s 的宿主测试
 * 与 3.6s 的 web 测试——「快」就没了。宿主侧的集成回归由 precheck 的三批全量测试覆盖。
 * 移除条件：出现「包改动只跑包测试、宿主测试却红了」的实际漏检，就把宿主批纳入闭包（或对高扇入的包
 * 单独设阈值）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { filterTestSummary } from "../ci-output";
import { TEST_BATCHES } from "./check-gates";
import { REPOSITORY_ROOT, type Step } from "./check-runner";

/** 一个 workspace 包：名字、目录（相对仓库根）与它依赖的其它 `@fenix/*` 包。 */
export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly deps: readonly string[];
}

export interface AffectedTests {
  /** 需要执行的测试步骤；空数组表示本次改动不影响任何单测。 */
  readonly steps: readonly Step[];
  /** 判定说明（逐行打印，让「为什么跑这些」可核对）。 */
  readonly notes: readonly string[];
}

/** 与单测无关的路径：文档、设计沙盘、部署面与本地数据。 */
const IGNORED_PATH_PATTERNS: readonly RegExp[] = [
  /^docs\//,
  /^e2e\//,
  /^ui-sandbox\//,
  /^tmp\//,
  /^logs\//,
  /^images\//,
  /^data\//,
  /^deploy\//,
  /^docker\//,
  /^drizzle\//,
  /^\.claude\//,
  /^\.github\//,
  /^\.husky\//,
  /^LICENSE$/,
  /^Dockerfile/,
  /^docker-compose\.yml$/,
  /^buildkitd\.toml$/,
  /^components\.json$/,
  /\.md$/,
];

/** 共享契约文件：改动它们的测试映射不可判定，保守跑全量三批。 */
const FULL_RUN_PATTERNS: readonly RegExp[] = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /^biome\.json$/,
  /^tsconfig(\.[a-z]+)?\.json$/,
  /^drizzle\.config\.ts$/,
];

const SERVER_BATCH = TEST_BATCHES[0] as Step;
const PACKAGE_BATCH = TEST_BATCHES[1] as Step;
const WEB_BATCH = TEST_BATCHES[2] as Step;

/** 归入宿主测试批的包：与 `check-gates.ts` 里该批的测试根一一对应，避免重复执行同一批测试。 */
const HOST_BATCH_PACKAGE_DIRS = new Set(["packages/platform/platform-sdk"]);

/** 单个包的测试步骤：按包目录整体跑，与全量 `packages/` 批用同一个忽略口径。 */
function packageTestStep(dir: string): Step {
  return {
    name: `tests (${dir})`,
    cmd: `bun test ${dir}/ --path-ignore-patterns 'tmp/**' 2>&1`,
    filter: filterTestSummary,
    weight: 20_000,
  };
}

/** 收集 `packages/` 两级目录下所有包的 name / dir / `@fenix/*` 依赖。 */
export function loadWorkspacePackages(): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];

  for (const entry of readDirNames(join(REPOSITORY_ROOT, "packages"))) {
    const dir = `packages/${entry}`;
    if (hasPackageJson(dir)) {
      packages.push(readPackage(dir));
      continue;
    }
    // 分组目录（`packages/resources/`、`packages/platform/` 等）没有 package.json，继续下钻一层。
    for (const child of readDirNames(join(REPOSITORY_ROOT, dir))) {
      const nested = `${dir}/${child}`;
      if (hasPackageJson(nested)) packages.push(readPackage(nested));
    }
  }

  return packages;
}

/** 读取本次改动涉及的路径：已跟踪文件的改动（含暂存）与未跟踪文件，结果去重且稳定排序。 */
export function collectChangedPaths(): string[] {
  const tracked = runGit(["diff", "--name-only", "HEAD"]);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked].filter((path) => path !== ""))].sort();
}

/**
 * 纯判定函数：由改动路径与包清单算出要跑的测试步骤。
 * 不读 git、不访问文件系统（包清单由调用方传入），便于用固定输入覆盖各条判定分支。
 * 唯一的外部依赖是 `hasTests` 的目录探测，供「包内没有任何测试目录」时跳过该包。
 */
export function resolveAffectedTests(
  changedPaths: readonly string[],
  packages: readonly WorkspacePackage[],
): AffectedTests {
  const notes: string[] = [];
  const packageByDir = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  const changedPackageDirs = new Set<string>();
  const serverPaths: string[] = [];
  const webPaths: string[] = [];

  for (const path of changedPaths) {
    if (IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(path))) continue;

    if (FULL_RUN_PATTERNS.some((pattern) => pattern.test(path))) {
      notes.push(`共享契约变更（${path}）：测试映射不可判定，保守跑全量三批`);
      return { steps: [SERVER_BATCH, PACKAGE_BATCH, WEB_BATCH], notes };
    }

    if (path.startsWith("apps/server/") || path.startsWith("db/") || path.startsWith("scripts/")) {
      serverPaths.push(path);
      continue;
    }
    if (path.startsWith("apps/web/")) {
      webPaths.push(path);
      continue;
    }

    // 最长前缀匹配：`packages/resources/skill/...` 必须命中该包，而不是它的分组目录。
    const owner = packageByDir.find((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}/`));
    if (!owner) {
      notes.push(`无法判定归属的路径（${path}）：保守跑全量三批`);
      return { steps: [SERVER_BATCH, PACKAGE_BATCH, WEB_BATCH], notes };
    }
    if (HOST_BATCH_PACKAGE_DIRS.has(owner.dir)) serverPaths.push(path);
    else changedPackageDirs.add(owner.dir);
  }

  if (changedPaths.length === 0) {
    notes.push("工作区无改动：跳过测试");
    return { steps: [], notes };
  }

  const steps: Step[] = [];
  if (serverPaths.length > 0) {
    notes.push(`${serverPaths.length} 个宿主/脚本改动 → 宿主测试批`);
    steps.push(SERVER_BATCH);
  }
  if (webPaths.length > 0) {
    notes.push(`${webPaths.length} 个宿主前端改动 → web 测试批`);
    steps.push(WEB_BATCH);
  }

  const nameByDir = new Map(packages.map((pkg) => [pkg.dir, pkg.name]));
  const changedNames = new Set([...changedPackageDirs].map((dir) => nameByDir.get(dir) ?? dir));
  for (const dir of findDependents(changedNames, packages)) {
    notes.push(`${dir}（${nameByDir.get(dir) ?? dir}）反向依赖变更包 → 纳入测试`);
    changedPackageDirs.add(dir);
  }

  for (const dir of [...changedPackageDirs].sort()) {
    if (!hasTests(dir)) {
      notes.push(`${dir} 没有 __tests__ 目录：跳过（bun test 遇到空目录会直接失败）`);
      continue;
    }
    steps.push(packageTestStep(dir));
  }

  if (steps.length === 0 && notes.length === 0) notes.push("改动未落到任何测试根：跳过测试");
  return { steps, notes };
}

/** 反向依赖闭包：逐轮扩散「依赖了已命中包」的包，直到不再增长。包数量在百级，无需更精巧的算法。 */
function findDependents(targets: ReadonlySet<string>, packages: readonly WorkspacePackage[]): string[] {
  const affectedNames = new Set(targets);
  const dependents: string[] = [];

  for (let changed = true; changed; ) {
    changed = false;
    for (const pkg of packages) {
      if (affectedNames.has(pkg.name)) continue;
      if (!pkg.deps.some((dep) => affectedNames.has(dep))) continue;
      affectedNames.add(pkg.name);
      dependents.push(pkg.dir);
      changed = true;
    }
  }

  return dependents;
}

function hasPackageJson(dir: string): boolean {
  return existsSync(join(REPOSITORY_ROOT, dir, "package.json"));
}

function readPackage(dir: string): WorkspacePackage {
  const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, dir, "package.json"), "utf8")) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const all = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  return {
    name: manifest.name ?? dir,
    dir,
    deps: Object.keys(all).filter((key) => key.startsWith("@fenix/")),
  };
}

function runGit(args: readonly string[]): string[] {
  const proc = Bun.spawnSync(["git", ...args], { cwd: REPOSITORY_ROOT, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} 失败：${proc.stderr.toString().trim() || "未知原因"}`);
  }
  return proc.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim());
}

/** 目录名列表；目录不存在或读不动时退化成空数组，不让整个判定崩掉。 */
function readDirNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 包内是否存在测试目录。形态不统一（`src/__tests__`、`src/server/__tests__`、`src/plugins/__tests__` 都有），
 * 故按 `src` / `web` / `db` 三个源码根递归找一次——`bun test <无测试目录>` 会以失败退出，必须在加入批次前判定。
 */
function hasTests(dir: string): boolean {
  for (const root of ["src", "web", "db"]) {
    const rootPath = join(REPOSITORY_ROOT, dir, root);
    if (existsSync(rootPath) && containsTestsDir(rootPath, 0)) return true;
  }
  return false;
}

function containsTestsDir(path: string, depth: number): boolean {
  if (depth > 4) return false;
  for (const entry of readDirNames(path)) {
    if (entry === "__tests__") return true;
    if (containsTestsDir(join(path, entry), depth + 1)) return true;
  }
  return false;
}
