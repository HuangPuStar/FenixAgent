/**
 * 包级类型检查门禁。
 *
 * **为什么需要它**：`tsc --noEmit`（根 `typecheck`）只以 `apps/server/src/**`、`db/**`、`scripts/**`
 * 为入口，`tsc -p apps/web/tsconfig.json`（`typecheck:web`）只从宿主前端入口出发——两者都**顺着 import**
 * 覆盖包源码，于是「没有任何消费方的包 / 文件」天然落在检查之外。本批实测的代价：14 个包此前连
 * `tsconfig.json` 都没有（`packages/platform` 3 个 + `packages/resources` 11 个），而
 * `packages/agent-runtime` 那一条配置级错误（TS5101 `baseUrl` 弃用）会让 tsc **跳过整个程序的语义检查**，
 * 把同一个程序里 6 条真实类型错误一起藏住。本门禁以**每个包自己的 tsconfig** 为入口逐个检查，
 * 覆盖范围不再取决于「谁 import 了它」。
 *
 * **验收出处**：§10.7.3（`precheck` 必须通过且没有 error 或 warning，故包级检查必须进 precheck）与
 * §10.2.3（包边界违规要「能阻断新增违规，而不是依赖人工约定」——每包都有独立的检查入口，是这条要求在
 * 包级编译面的落地；`package.json` 的 `exports` 指向 `src/*.ts`，包一经声明即承担独立可编译的义务）。
 *
 * **口径**：
 * - 发现规则：`packages/` 下两级（直接子目录，以及分组目录的子目录），凡有 `package.json` 的包都必须有
 *   `tsconfig.json`，缺一个即失败——「每个包都有包级检查入口」正是本门禁的目的，
 *   缺包不报就等于门禁可以靠删配置绕过。分组目录（`packages/platform/`、`packages/resources/`）
 *   与空目录（`packages/acp-server/`）没有 `package.json`，自然跳过。
 * - 忽略口径：只拦**生产源码**的诊断。测试专属文件（`__tests__/`、`*.test.*`、`*.spec.*`、
 *   `fixtures/`、`test-utils/`）下的既有错误本轮不修，但**不静默**：每次运行都打印被忽略的条数。
 *   移除条件：测试文件的既有错误清到 0 后，删掉 `TEST_FILE_PATTERN` 与那行统计——与根 `tsconfig.json`
 *   里 `scripts/__tests__` 条目同一口径（那里也是「先纳入，再带移除条件地豁免」）。
 * - 判定：按 `文件:行:错误码` 去重后仍有非测试诊断即失败（同一文件可能被多个包的程序各报一次，
 *   去重后仍逐条列出「哪些包的程序报了它」）。
 *
 * **只读**：不写盘、不改文件，逐包执行 `tsc -p <pkg>/tsconfig.json --noEmit`。
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const tscBin = join(repositoryRoot, "node_modules", ".bin", "tsc");

/**
 * 并发上限。实测（10 核机、35 个包）：总 CPU 约 280s，8 路并发后 wall 约 35s；
 * 提到 12 路 wall 不变（已打满核），故取 8 以压低内存与文件句柄峰值。
 */
const CONCURRENCY = 8;

/** tsc 诊断行形如 `packages/x/src/y.ts(12,3): error TS1234: <message>`（路径相对进程工作目录）。 */
const DIAGNOSTIC_PATTERN = /^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * 测试专属文件的路径特征。刻意不含两类容易误判的名字：
 * `web/types/*.d.ts` 是包自带类型垫片、`src/server/testing.ts` 是包 `exports` 公开的测试支撑入口，
 * 二者都是对外契约的一部分，必须继续被检查。
 */
const TEST_FILE_PATTERN = /(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx?$|\/(?:fixtures?|test-utils)\//;

interface PackageEntry {
  /** 相对仓库根的目录，如 `packages/resources/task`。 */
  readonly dir: string;
  /** 相对仓库根的 tsconfig 路径。 */
  readonly config: string;
}

/** 一条按「文件:行:错误码」去重后的诊断，附上报它的包程序。 */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly message: string;
  readonly packages: string[];
}

/** 发现两级 workspace 目录，并挑出缺 `tsconfig.json` 的包。 */
function collectPackages(): { entries: PackageEntry[]; missing: string[] } {
  const entries: PackageEntry[] = [];
  const missing: string[] = [];

  // `depth` 以 `packages` 自身为 0：包要么是它的直接子目录，要么在分组目录之下（`platform/`、`resources/`），
  // 到第二级为止。分组目录没有 `package.json`，必须继续下钻；包目录有，不再深入。
  const visit = (dir: string, depth: number): void => {
    if (existsSync(join(repositoryRoot, dir, "package.json"))) {
      const config = join(dir, "tsconfig.json");
      if (existsSync(join(repositoryRoot, config))) entries.push({ dir, config });
      else missing.push(dir);
      return;
    }
    if (depth >= 2) return;
    for (const child of readdirSync(join(repositoryRoot, dir), { withFileTypes: true })) {
      if (child.isDirectory()) visit(join(dir, child.name), depth + 1);
    }
  };

  visit("packages", 0);
  return { entries, missing };
}

/** 跑一次包级 tsc，只回传诊断行（tsc 的退出码对「有错误」与「配置坏」都是 1，故以诊断行判定）。 */
async function runTsc(entry: PackageEntry): Promise<string[]> {
  const proc = Bun.spawn([tscBin, "-p", entry.config, "--noEmit"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return `${stdout}\n${stderr}`.split("\n").filter((line) => line.includes("error TS"));
}

/** 并发跑完全部包（单线程游标分配，避免一次性起 35 个进程）。 */
async function runAll(entries: readonly PackageEntry[]): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      if (!entry) continue;
      results.set(entry.dir, await runTsc(entry));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  return results;
}

/** 把各包程序报出的诊断合并去重；同一文件被多个包的程序报出时合并 `packages`，只留一条。 */
function mergeFindings(results: ReadonlyMap<string, string[]>): Finding[] {
  const merged = new Map<string, { finding: Finding; packages: Set<string> }>();
  for (const [dir, lines] of results) {
    for (const line of lines) {
      const match = DIAGNOSTIC_PATTERN.exec(line);
      if (!match) continue;
      const [, file, lineNumber, , code, message] = match;
      if (file === undefined || lineNumber === undefined || code === undefined || message === undefined) continue;
      const key = `${file}|${lineNumber}|${code}`;
      const existing = merged.get(key);
      if (existing) {
        existing.packages.add(dir);
        continue;
      }
      merged.set(key, {
        finding: { file, line: Number(lineNumber), code, message, packages: [] },
        packages: new Set([dir]),
      });
    }
  }
  return [...merged.values()].map(({ finding, packages }) => ({ ...finding, packages: [...packages].sort() }));
}

/** 执行门禁并返回进程退出码。 */
export async function checkPackageTypecheck(): Promise<number> {
  const { entries, missing } = collectPackages();
  if (missing.length > 0) {
    console.error(`以下 workspace 包没有包级 tsconfig，本门禁覆盖不到它们（每包都必须有）：`);
    for (const dir of missing) console.error(`  ${dir}/tsconfig.json`);
    return 1;
  }

  const findings = mergeFindings(await runAll(entries));
  const production = findings.filter((finding) => !TEST_FILE_PATTERN.test(finding.file));
  const ignored = findings.length - production.length;

  if (production.length > 0) {
    console.error(`包级类型检查失败：${production.length} 条生产源码诊断（已忽略测试文件 ${ignored} 条）`);
    for (const { file, line, code, message, packages } of production) {
      console.error(`  ${file}:${line} ${code}: ${message}`);
      console.error(`    [程序: ${packages.join(", ")}]`);
    }
    return 1;
  }

  console.log(
    `✓ typecheck-packages (pkg=${entries.length} errors=0 ignored-tests=${ignored})` +
      `\n  测试文件的既有错误按脚本头部登记的移除条件豁免，见 scripts/typecheck-packages.ts。`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await checkPackageTypecheck());
}
