/**
 * workspace 依赖边界门禁。
 *
 * 判定来源是 `.dependency-cruiser.cjs` 的声明式规则；本脚本只负责三件规则文件表达不了的事：
 *
 * 1. 把「解析失败」变成显式失败。dependency-cruiser 默认把 `couldNotResolve` 当作普通信息，
 *    一旦解析器配置退化（本仓库曾因缺少 `exportsFields` 让全部 `@fenix/*` 导入解析失败），
 *    循环与跨包规则会安静地报告 0 违规，门禁形同不存在。
 * 2. 把文件级违规归一成「规则 + 来源包 + 目标包」的指纹，与 `scripts/architecture/exceptions.json`
 *    比对：只有**未登记**的新违规才失败。
 * 3. 台账中已经不再违规的条目直接报错。台账是待清偿清单而不是永久豁免名单，阶段末必须为空
 *    （见 ce-ee-engineering-standards §10.7.4）。
 *
 * 另有一步**独立**的源码扫描：子进程环境不得整段继承宿主 `process.env`
 * （ce-ee-engineering-standards §10.6.3「子进程和 Provider 只获得白名单」）。该步骤刻意不进
 * `cruise()` 的违规归一流程——污染「规则 + 来源包 + 目标包」指纹台账会让例外登记失去意义。
 */

import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type ArchitectureException,
  exceptionFingerprint,
  loadArchitectureLedger,
} from "./lib/architecture-exceptions";
import { createPackageNameResolver, loadWorkspacePackages, normalizePath } from "./lib/workspace-packages";

const CONFIG_FILE = ".dependency-cruiser.cjs";
const CRUISE_BIN = "node_modules/dependency-cruiser/bin/dependency-cruise.mjs";
const CRUISE_TARGETS = ["apps", "packages"] as const;

/**
 * 宿主环境变量扫描的源码范围：仅 packages 下各包 `src/` 目录（递归）。
 *
 * 范围故意不含 `apps/**`：apps 侧由宿主装配层人工保证（本次收窄前实测 apps 为零命中），
 * 本步骤因此**不是**全仓门禁，覆盖的是 packages 内的子进程 spawn 点。
 */
const HOST_ENV_SCAN_ROOT = "packages";
const HOST_ENV_SCAN_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"] as const;
const HOST_ENV_SCAN_SKIP_DIRS = new Set(["node_modules", "dist"]);

/**
 * 「子进程拿到全量宿主环境」的检测形状：`...process.env` / `...Bun.env` 展开，且位于对象字面量
 * 属性位置（`env:` 位置、或绑定名为 `env` 的字面量都是这种形态）。
 *
 * 末位否定断言排除了「展开的是成员访问结果」的形态：`...(process.env.X ? [a] : [])` 与
 * `...process.env.X` 展开的是数组/单值，不是宿主环境本体（`packages/acp-link/src/server.ts`
 * 的 supported_engine_types 就是这个形状），必须零误伤。
 */
const HOST_ENV_SPREAD_PATTERN = /(?:^|[\s{,(])\.\.\.\s*\(?\s*(?:process|Bun)\.env\b(?!\s*[.[])/;

/** 递归收集 packages 下各包 `src/` 目录里的源码文件。 */
async function collectHostEnvScanFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, inSourceTree: boolean): Promise<void> => {
    // 显式给出 `Dirent<string>`：`Awaited<ReturnType<typeof readdir>>` 会落到最后一条重载
    // （`Dirent<NonSharedBuffer>`），与实际返回的 `Dirent<string>[]` 冲突。
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (HOST_ENV_SCAN_SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath, inSourceTree || entry.name === "src");
        continue;
      }
      if (!inSourceTree) continue;
      if (HOST_ENV_SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(fullPath);
    }
  };
  await walk(root, false);
  return files;
}

/**
 * 扫描 packages 下各包 `src/` 目录，返回「子进程环境整段继承宿主 `process.env`」的 `文件:行号` 列表。
 *
 * 导出供门禁自检使用；`fileList` 仅测试注入，生产从 `repositoryRoot` 递归收集。
 */
export async function findHostEnvSpreadViolations(
  repositoryRoot: string,
  fileList?: readonly string[],
): Promise<string[]> {
  const files = fileList ?? (await collectHostEnvScanFiles(join(repositoryRoot, HOST_ENV_SCAN_ROOT)));
  const violations: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (!content.includes("process.env") && !content.includes("Bun.env")) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (HOST_ENV_SPREAD_PATTERN.test(lines[index] ?? "")) {
        violations.push(`${normalizePath(relative(repositoryRoot, file))}:${index + 1}`);
      }
    }
  }
  return violations;
}

/** dependency-cruiser JSON 报告中门禁实际使用的字段。 */
interface CruiseReport {
  readonly modules: readonly {
    readonly source: string;
    readonly dependencies: readonly {
      readonly module: string;
      readonly resolved?: string;
      readonly couldNotResolve?: boolean;
    }[];
  }[];
  readonly summary: {
    readonly violations: readonly {
      readonly rule: { readonly name: string };
      readonly from: string;
      readonly to: string;
    }[];
  };
}

/** 归一后的边界违规。 */
export interface BoundaryViolation {
  readonly rule: string;
  readonly from: string;
  readonly to: string;
}

/** 指纹比对结果。 */
export interface BoundaryComparison {
  readonly unregistered: readonly (BoundaryViolation & { readonly count: number })[];
  readonly registeredCount: number;
  readonly stale: readonly ArchitectureException[];
}

function parseRoot(args: readonly string[]): string {
  const rootIndex = args.indexOf("--root");
  if (rootIndex === -1) return process.cwd();

  const value = args[rootIndex + 1];
  if (!value || value.startsWith("--")) throw new Error("--root 需要目录参数");
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

/**
 * 调用 dependency-cruiser CLI 并解析 JSON 报告。
 *
 * 使用 CLI 而不是 Node API：规则文件是唯一判定来源，走同一条配置解析路径可以避免
 * 「门禁脚本自己解释规则」造成二次真相。cwd 固定为仓库根——dependency-cruiser 解析
 * tsconfig `paths` 时以运行目录为基准。
 */
function cruise(repositoryRoot: string): CruiseReport {
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, CRUISE_BIN), "--config", CONFIG_FILE, "--output-type", "json", ...CRUISE_TARGETS],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );

  // 存在违规时 dependency-cruiser 同样以非 0 退出，报告本身仍完整写到 stdout，
  // 因此这里不能按退出码判定失败——只有拿不到可解析的报告才算门禁本身出错。
  const stdout = (result.stdout ?? "").trim();
  if (!stdout.startsWith("{")) {
    throw new Error(
      `dependency-cruiser 未输出 JSON 报告（exit=${result.status}）：${(result.stderr ?? "").trim().slice(0, 2000)}`,
    );
  }

  return JSON.parse(stdout) as CruiseReport;
}

/** 收集解析失败的依赖，附带来源文件，便于直接定位。 */
function collectUnresolved(repositoryRoot: string, report: CruiseReport): string[] {
  const unresolved: string[] = [];
  for (const module of report.modules) {
    for (const dependency of module.dependencies) {
      if (!dependency.couldNotResolve) continue;
      const source = normalizePath(
        module.source.startsWith(repositoryRoot) ? module.source.slice(repositoryRoot.length + 1) : module.source,
      );
      unresolved.push(`${source} -> ${dependency.module}`);
    }
  }
  return unresolved;
}

/**
 * 读取规则文件里声明的全部规则名。
 *
 * 不能只从违规里反推规则名：那样「规则被删除或改名、台账条目随之失效」这一情形永远发现不了，
 * 而它正是台账必须收缩的信号。
 */
function loadConfiguredRuleNames(repositoryRoot: string): readonly string[] {
  const config = createRequire(import.meta.url)(join(repositoryRoot, CONFIG_FILE)) as {
    readonly forbidden?: readonly { readonly name?: unknown }[];
  };
  return (config.forbidden ?? []).flatMap((rule) => (typeof rule.name === "string" ? [rule.name] : []));
}

/** 把文件级违规归一为包级指纹并分类。 */
export function compareBoundaryViolations(input: {
  readonly violations: readonly BoundaryViolation[];
  readonly exceptions: ReadonlyMap<string, ArchitectureException>;
  /**
   * 本门禁负责的规则名。
   *
   * 台账由本门禁与 `scripts/check-architecture.ts` 共用，而两边只看得到各自规则的违规；
   * 不限定范围就会把对方仍在生效的条目误判成「已失效」。
   */
  readonly ownRuleNames: readonly string[];
}): BoundaryComparison {
  const counts = new Map<string, BoundaryViolation & { count: number }>();
  for (const violation of input.violations) {
    const key = exceptionFingerprint(violation.rule, violation.from, violation.to);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    counts.set(key, { ...violation, count: 1 });
  }

  const unregistered: (BoundaryViolation & { count: number })[] = [];
  let registeredCount = 0;
  for (const [key, violation] of counts) {
    if (input.exceptions.has(key)) {
      registeredCount += 1;
      continue;
    }
    unregistered.push(violation);
  }

  const owned = new Set(input.ownRuleNames);
  const stale: ArchitectureException[] = [];
  for (const [key, exception] of input.exceptions) {
    if (counts.has(key) || !owned.has(exception.rule)) continue;
    stale.push(exception);
  }

  return { registeredCount, stale, unregistered };
}

/** 执行门禁；返回进程退出码，便于测试直接断言。 */
export async function checkDependencyBoundaries(
  options: { readonly repositoryRoot?: string; readonly cruiseReport?: CruiseReport } = {},
): Promise<number> {
  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(import.meta.dir, ".."));

  // 源码扫描先于 dependency-cruiser（后者要跑完整个 apps + packages 解析），失败时快速返回。
  const hostEnvSpreads = await findHostEnvSpreadViolations(repositoryRoot);
  if (hostEnvSpreads.length > 0) {
    console.log(`✗ dependency-boundaries 发现 ${hostEnvSpreads.length} 处子进程环境整段继承宿主 process.env`);
    for (const location of hostEnvSpreads) console.log(`  ${location}`);
    console.log("  子进程与 Provider 只能获得白名单环境：替换打底对象，不要展开 process.env / Bun.env");
    return 1;
  }

  const report = options.cruiseReport ?? cruise(repositoryRoot);

  const unresolved = collectUnresolved(repositoryRoot, report);
  if (unresolved.length > 0) {
    console.log(`✗ dependency-boundaries 解析失败 ${unresolved.length} 条，门禁结论不可信`);
    for (const entry of unresolved.slice(0, 40)) console.log(`  ${entry}`);
    if (unresolved.length > 40) console.log(`  ... 其余 ${unresolved.length - 40} 条省略`);
    return 1;
  }

  const workspacePackages = await loadWorkspacePackages(repositoryRoot);
  const resolvePackageName = createPackageNameResolver(workspacePackages);
  const violations: BoundaryViolation[] = report.summary.violations.map((violation) => ({
    from: resolvePackageName(violation.from),
    rule: violation.rule.name,
    to: resolvePackageName(violation.to),
  }));

  const ledger = await loadArchitectureLedger(repositoryRoot);
  const comparison = compareBoundaryViolations({
    exceptions: ledger.exceptions,
    ownRuleNames: loadConfiguredRuleNames(repositoryRoot),
    violations,
  });

  if (comparison.unregistered.length === 0 && comparison.stale.length === 0) {
    console.log(
      `✓ dependency-boundaries (${report.modules.length} modules, ${comparison.registeredCount} 条已登记例外, 0 条新增违规)`,
    );
    return 0;
  }

  if (comparison.unregistered.length > 0) {
    console.log(`✗ dependency-boundaries 发现 ${comparison.unregistered.length} 类未登记违规`);
    for (const violation of comparison.unregistered) {
      console.log(`  [${violation.rule}] ${violation.from} -> ${violation.to} (${violation.count} 处)`);
    }
    console.log("  修复依赖方向，或在 scripts/architecture/exceptions.json 登记精确的包对与移除条件");
  }

  if (comparison.stale.length > 0) {
    console.log(`✗ 架构例外台账有 ${comparison.stale.length} 条已不再违规，必须删除`);
    for (const exception of comparison.stale) {
      console.log(`  [${exception.rule}] ${exception.from} -> ${exception.to} (owner: ${exception.owner})`);
    }
  }

  return 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await checkDependencyBoundaries({ repositoryRoot: parseRoot(process.argv.slice(2)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ dependency-boundaries failed: ${message}`);
    process.exitCode = 1;
  }
}
