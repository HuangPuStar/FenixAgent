/**
 * 覆盖率审计脚本 — 按统一口径输出测试覆盖报告。
 *
 * 背景：`bun test --coverage` 的报告列序为 `% Funcs | % Lines`，且只列出被测试加载过的文件。
 * 历史上曾把"函数覆盖 0%"误读为"行覆盖 0%"，并遗漏了从未被测试 import 的文件（真正的盲区）。
 * 本脚本固化统一口径：
 *   - 覆盖 = 行覆盖（`% Lines`，报告第二列）；函数覆盖仅作参考（第一列 `% Funcs`）。
 *   - 0% = 行覆盖为 0；低覆盖 = 行覆盖 < 30%。
 *   - 未加载 = 从未被任何测试 import（Bun 报告不会列出，需与全量源文件对比）。
 *
 * 用法：
 *   bun run coverage:audit                         # 运行全仓测试并审计（约 25s）
 *   bun run coverage:audit -- --input <file>       # 复用已有覆盖率输出（跳过测试）
 *   bun run coverage:audit -- --help
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const COVERAGE_ROOTS = ["src", "web/src", "web/components", "packages"];
const LOW_COVERAGE_THRESHOLD = 30;
/** 报告文件路径白名单：仅统计项目源文件，过滤代码转储行（如 "288 | }"）与 cwd 外临时文件。 */
const SOURCE_PREFIX_RE = /^(src|web|packages)\//;

/** 报告中被排除统计的路径（测试文件、测试基础设施、cwd 之外的临时文件）。 */
function isReportExcluded(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    relPath.includes("test-utils") ||
    relPath.endsWith(".test.ts") ||
    relPath.endsWith(".test.tsx") ||
    relPath.startsWith("../") ||
    relPath.includes("/tmp/")
  );
}

/** 全量收集中被排除的路径（测试文件、测试基础设施、生成/声明文件、依赖目录）。 */
function isSourceExcluded(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    relPath.includes("test-utils") ||
    relPath.includes("node_modules") ||
    relPath.includes("/dist/") ||
    relPath.endsWith(".gen.ts") ||
    relPath.endsWith(".d.ts") ||
    relPath.endsWith(".test.ts") ||
    relPath.endsWith(".test.tsx")
  );
}

/** 递归收集相对路径列表（posix 风格，与覆盖率报告保持一致）。 */
function collectSourceFiles(root: string): string[] {
  const result: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // 跳过符号链接（workspace 的 node_modules 嵌套链接会成环），源文件均由各 root 直接覆盖
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        const rel = posix.relative(process.cwd(), full).replaceAll("\\", "/");
        if (!isSourceExcluded(rel)) result.push(rel);
      }
    }
  };
  walk(root);
  return result;
}

interface ReportFile {
  path: string;
  funcs: number;
  lines: number;
}

/** 解析 bun test --coverage 的文本输出，返回全局指标、文件列表与测试汇总。 */
function parseCoverageReport(raw: string): {
  files: ReportFile[];
  totalLines: number | null;
  totalFuncs: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  ran: number | null;
  durationSec: number | null;
} {
  const files: ReportFile[] = [];
  let totalLines: number | null = null;
  let totalFuncs: number | null = null;
  let passed: number | null = null;
  let failed: number | null = null;
  let skipped: number | null = null;
  let ran: number | null = null;
  let durationSec: number | null = null;

  // 剥离 ANSI 颜色码（正则字面量不允许控制字符，改用构造方式）
  const ESC = String.fromCharCode(27);
  const text = raw.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
  for (const line of text.split("\n")) {
    const name = line.split("|")[0]?.trim() ?? "";
    if (name === "All files") {
      const parts = line.split("|");
      totalFuncs = Number.parseFloat(parts[1] ?? "");
      totalLines = Number.parseFloat(parts[2] ?? "");
      continue;
    }
    if (!line.includes("|") || name === "" || name === "File" || name.startsWith("---")) continue;
    if (!SOURCE_PREFIX_RE.test(name)) continue; // 路径白名单：代码转储行（"数字 | 数字"）与 cwd 外文件均在此被过滤
    if (isReportExcluded(name)) continue; // 测试文件、测试基础设施不参与统计
    const parts = line.split("|");
    const funcs = Number.parseFloat(parts[1] ?? "");
    const lines = Number.parseFloat(parts[2] ?? "");
    if (Number.isNaN(funcs) || Number.isNaN(lines)) continue;
    files.push({ path: name, funcs, lines });
  }

  const passMatch = text.match(/^\s*(\d+)\s+pass\b/m);
  const skipMatch = text.match(/^\s*(\d+)\s+skip\b/m);
  const failMatch = text.match(/^\s*(\d+)\s+fail\b/m);
  const ranMatch = text.match(/Ran\s+(\d+)\s+tests across\s+(\d+)\s+files\.\s*\[([\d.]+)s\]/);
  passed = passMatch ? Number(passMatch[1]) : null;
  skipped = skipMatch ? Number(skipMatch[1]) : null;
  failed = failMatch ? Number(failMatch[1]) : null;
  ran = ranMatch ? Number(ranMatch[1]) : null;
  durationSec = ranMatch ? Number(ranMatch[3]) : null;

  return { files, totalLines, totalFuncs, passed, failed, skipped, ran, durationSec };
}

function parseArgs(argv: string[]): { input?: string } {
  const args: { input?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) {
      args.input = argv[i + 1];
      i++;
    } else if (argv[i] === "--help") {
      console.log(
        [
          "覆盖率审计脚本（统一口径）",
          "",
          "用法:",
          "  bun run coverage:audit                        # 运行全仓测试并审计（约 25s）",
          "  bun run coverage:audit -- --input <file>      # 复用已有覆盖率输出",
          "",
          "统一口径:",
          "  覆盖 = 行覆盖（% Lines，报告第二列）；函数覆盖仅作参考。",
          "  0% = 行覆盖为 0；低覆盖 = 行覆盖 < 30%。",
          "  未加载 = 从未被任何测试 import（Bun 报告不会列出）。",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return args;
}

/** 统计"未加载"文件：全量源文件中从未出现在覆盖率报告里的。 */
function diffUnloaded(allSources: string[], reported: Set<string>): string[] {
  return allSources.filter((p) => !reported.has(p)).sort();
}

/** 按顶层范围聚合统计（src / web / packages/<pkg>）。 */
function aggregate(
  files: ReportFile[],
  allSources: string[],
): Map<string, { total: number; loaded: number; zero: number; low: number }> {
  const reported = new Set(files.map((f) => f.path));
  const groupOf = (p: string): string => {
    if (p.startsWith("packages/")) {
      const seg = p.split("/");
      return seg.length > 1 ? `packages/${seg[1]}` : "packages";
    }
    return p.startsWith("web/") ? "web" : "src";
  };

  const map = new Map<string, { total: number; loaded: number; zero: number; low: number }>();
  for (const p of allSources) {
    const key = groupOf(p);
    const agg = map.get(key) ?? { total: 0, loaded: 0, zero: 0, low: 0 };
    agg.total++;
    if (reported.has(p)) {
      agg.loaded++;
      const file = files.find((f) => f.path === p);
      if (file) {
        if (file.lines === 0) agg.zero++;
        if (file.lines < LOW_COVERAGE_THRESHOLD) agg.low++;
      }
    }
    map.set(key, agg);
  }
  return map;
}

function renderReport(raw: string): void {
  const report = parseCoverageReport(raw);
  // --input 输入校验：无覆盖率表格时直接报错，避免输出"全部未加载"的假报告
  if (report.files.length === 0 || report.totalLines === null) {
    console.error("输入中未找到覆盖率表格（请传入 `bun test --coverage` 的完整输出）。");
    process.exit(1);
  }
  const reported = new Set(report.files.map((f) => f.path));
  const allSources = COVERAGE_ROOTS.flatMap(collectSourceFiles);
  const unloaded = diffUnloaded(allSources, reported);

  const linesZero = report.files.filter((f) => f.lines === 0).sort((a, b) => a.path.localeCompare(b.path));
  const linesLow = report.files
    .filter((f) => f.lines > 0 && f.lines < LOW_COVERAGE_THRESHOLD)
    .sort((a, b) => a.lines - b.lines);
  // ui 薄包装组件按《测试方针》§6.4 豁免，单独分组列出，不混入通用低覆盖清单
  const linesLowExempt = linesLow.filter((f) => f.path.startsWith("web/components/ui/"));
  const linesLowRest = linesLow.filter((f) => !f.path.startsWith("web/components/ui/"));

  const head = [
    "# 覆盖率审计报告",
    "",
    "> **统一口径**：覆盖 = 行覆盖（`% Lines`，Bun 报告第二列）；函数覆盖仅作参考。",
    "> 0% = 行覆盖为 0；低覆盖 = 行覆盖 < 30%；未加载 = 从未被测试 import（Bun 报告不列出，需对比全量源文件）。",
    "",
  ];
  const testLine =
    report.ran === null
      ? "- 测试汇总：未能解析（--input 内容不完整？）"
      : `- 测试：${report.ran} 个（pass ${report.passed ?? "?"} / skip ${report.skipped ?? "?"} / fail ${report.failed ?? "?"}${report.durationSec !== null ? `，耗时 ${report.durationSec}s` : ""}）`;
  // 全局行覆盖：bun 的 All files 是"被加载文件"的百分比简单均值（不含测试文件，未计入未加载文件）
  const overallMean = report.files.reduce((acc, f) => acc + f.lines, 0) / allSources.length;
  const globalLine =
    report.totalLines === null
      ? ""
      : `- 全局：被加载文件行覆盖简单均值 ${report.totalLines.toFixed(2)}%（bun All files 口径）；计入未加载（按 0 计）后整体均值 ${overallMean.toFixed(2)}%`;
  console.log([...head, testLine, globalLine, ""].join("\n"));

  console.log("## 目录聚合");
  console.log("| 范围 | 源文件 | 被测 | 未加载 | 行覆盖 0% | 行覆盖 <30% |");
  console.log("|------|-------:|-----:|-------:|----------:|------------:|");
  const agg = aggregate(report.files, allSources);
  const orderedKeys = [...agg.keys()].sort((a, b) => {
    const rank = (k: string): number => (k === "src" ? 0 : k === "web" ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const key of orderedKeys) {
    const v = agg.get(key);
    if (!v) continue;
    console.log(`| ${key} | ${v.total} | ${v.loaded} | ${v.total - v.loaded} | ${v.zero} | ${v.low} |`);
  }
  console.log("");

  console.log("## 行覆盖 0% 文件（仅被加载文件中，应修复）");
  if (linesZero.length === 0) {
    console.log("无。");
  } else {
    for (const f of linesZero) console.log(`- ${f.path}`);
  }
  console.log("");

  console.log(`## 行覆盖 <${LOW_COVERAGE_THRESHOLD}% 文件（低覆盖区，按升序，不含 §6.4 豁免类）`);
  if (linesLowRest.length === 0) {
    console.log("无。");
  } else {
    for (const f of linesLowRest) console.log(`- ${f.lines.toFixed(2)}%  ${f.path}`);
  }
  if (linesLowExempt.length > 0) {
    console.log("");
    console.log(`§6.4 豁免类（web/components/ui/ 薄包装，仅列参考）：${linesLowExempt.length} 个`);
    for (const f of linesLowExempt) console.log(`- ${f.lines.toFixed(2)}%  ${f.path}`);
  }
  console.log("");

  console.log("## 未加载文件（真正盲区，Bun 报告不列出）");
  if (unloaded.length === 0) {
    console.log("无。");
  } else {
    for (const p of unloaded) console.log(`- ${p}`);
  }
  console.log("");
  console.log(
    `统计口径：全量源文件 ${allSources.length}（排除 __tests__/test-utils/node_modules/dist/*.gen.ts/*.d.ts，跳过符号链接），报告内源文件 ${report.files.length}。`,
  );
  console.log("注意：未加载清单可能包含纯类型文件（仅被 `import type` 引用）与死代码，需人工甄别后再补测试。");
}

const args = parseArgs(process.argv.slice(2));

if (args.input) {
  if (!existsSync(args.input)) {
    console.error(`输入文件不存在：${args.input}`);
    process.exit(1);
  }
  renderReport(readFileSync(args.input, "utf8"));
} else {
  const result = spawnSync("bun", ["test", "--coverage"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    console.error("bun test --coverage 执行失败，输出前 200 行：");
    console.error(result.stdout.slice(0, 20_000));
    console.error(result.stderr);
    process.exit(1);
  }
  // bun 在管道模式下把覆盖率表格输出到 stderr，需合并渲染
  renderReport(`${result.stdout}\n${result.stderr}`);
}
