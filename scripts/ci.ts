/**
 * CI 全通过脚本 — 只输出有用的信息。
 *
 * 步骤：biome format → biome check (import 排序) → architecture → tsc → biome lint → bun test
 * 格式/lint 自动修复，类型检查和测试只报告失败项。
 */

import { execSync } from "node:child_process";

import { filterTestSummary } from "./ci-output";

const STEPS = [
  {
    name: "format",
    cmd: "biome format --write apps/server/src/ apps/ packages/ scripts/ db/ docs/.vitepress/",
    filter: (out: string) => {
      if (out.includes("No fixes applied") || out.includes("Formatted")) return null;
      return out;
    },
  },
  {
    name: "import-sort",
    cmd: "biome check --write --linter-enabled=false apps/server/src/ apps/ packages/ scripts/ db/ docs/.vitepress/",
    filter: (out: string) => {
      if (out.includes("No fixes applied") || out.includes("Checked")) return null;
      return out;
    },
  },
  {
    name: "module-registry",
    cmd: "bun run generate:module-registry --check",
    filter: (out: string) => (out.includes("已验证") ? null : out),
  },
  {
    name: "web-contributions",
    cmd: "bun run generate:web-contributions --check",
    filter: (out: string) => (out.includes("已验证") ? null : out),
  },
  {
    // 根源码归属清单同样是「文档 == 规则表产出」的生成物门禁，必须与 CI 走同一入口。
    name: "owner-inventory",
    cmd: "bun run check:root-owner-inventory",
    filter: (out: string) => (out.includes("unowned=0 ambiguous=0") ? null : out),
  },
  {
    // 表搬迁只搬位置、不改结构：schema 聚合结果与已发布迁移链必须零 DDL 差异（§6.1 / §10.6.1）。
    name: "schema-ddl-drift",
    cmd: "bun run check:schema-ddl-drift",
    filter: (out: string) => (out.includes("✓ schema-ddl-drift") ? null : out),
  },
  {
    name: "architecture",
    cmd: "bun run architecture:check",
    filter: (out: string) => (out.includes("✓ architecture-check") ? null : out),
  },
  {
    // Web 样式禁止行为（FCP-WEB-01..06）：台账登记存量，只阻断新增；规则与反例见
    // docs/developer/guide/forbidden-code-patterns.md。
    name: "web-style",
    cmd: "bun run check:web-style",
    filter: (out: string) => (out.includes("✓ web-style") ? null : out),
  },
  {
    name: "tsc (server)",
    cmd: "tsc --noEmit",
    filter: (out: string) => {
      const errors = out.split("\n").filter((l) => l.includes("error TS"));
      return errors.length > 0 ? errors.join("\n") : null;
    },
  },
  {
    name: "tsc (web)",
    cmd: "tsc -p apps/web/tsconfig.json --noEmit",
    filter: (out: string) => {
      const errors = out.split("\n").filter((l) => l.includes("error TS"));
      return errors.length > 0 ? errors.join("\n") : null;
    },
  },
  {
    name: "tsc (app skeletons)",
    cmd: "tsc -p apps/server/tsconfig.json --noEmit && tsc -p apps/web/tsconfig.json --noEmit",
    filter: (out: string) => {
      const errors = out.split("\n").filter((l) => l.includes("error TS"));
      return errors.length > 0 ? errors.join("\n") : null;
    },
  },
  {
    // 包级 tsconfig 逐个检查：根 `tsc` 与 web `tsc` 都**顺 import** 走，没有消费方的包/文件天然
    // 落在检查之外。口径、并发与测试文件豁免的移除条件见 `scripts/typecheck-packages.ts` 头部。
    name: "tsc (packages)",
    cmd: "bun run typecheck:packages",
    filter: (out: string) => (out.includes("✓ typecheck-packages") ? null : out),
  },
  {
    name: "dependency-boundaries",
    cmd: "bun run check:dependencies",
    filter: (out: string) => (out.includes("✓ dependency-boundaries") ? null : out),
  },
  {
    name: "lint",
    cmd: "biome check apps/server/src/ apps/ packages/ scripts/ db/ docs/.vitepress/",
    filter: (out: string) => {
      if (out.includes("Checked") && !out.includes("error") && !out.includes("warning")) return null;
      // 只保留有问题的文件行
      const lines = out.split("\n").filter((l) => !l.match(/^Checked\s/) && l.trim() !== "");
      return lines.length > 0 ? lines.join("\n") : null;
    },
  },
  {
    name: "server-and-script-tests",
    cmd: "bun test apps/server/src/__tests__/ scripts/__tests__/ packages/platform/platform-sdk/src/__tests__/ 2>&1",
    filter: filterTestSummary,
  },
  {
    name: "package-tests",
    cmd: "bun test packages/ --path-ignore-patterns 'tmp/**' 2>&1",
    filter: filterTestSummary,
  },
  {
    name: "web-app-tests",
    cmd: "bun test apps/web/src/__tests__/ 2>&1",
    filter: filterTestSummary,
  },
] as const;

function runStep(step: (typeof STEPS)[number]): { ok: boolean; output: string | null; ms: number } {
  const start = Date.now();
  try {
    const raw = execSync(step.cmd, {
      encoding: "utf-8",
      timeout: 300_000,
      // execSync 默认 maxBuffer 只有 1MB，而本仓库 bun test 已是 600+ 文件、8000+ 用例。
      // 输出一旦越过上限就抛 ENOBUFS，且只保留前 1MB：末尾的 pass/fail 摘要整体丢失，
      // filter 只能退化成日志片段，步骤被误报成"测试失败"。这里的上限按当前规模的十倍余量设置。
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ms = Date.now() - start;
    return { ok: true, output: step.filter(raw), ms };
  } catch (err: unknown) {
    const ms = Date.now() - start;
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number | null;
      signal?: string | null;
      message?: string;
    };
    const combined = [e.stdout ?? "", e.stderr ?? ""].join("\n");
    // 进程被信号终止、超时或 stdout 溢出时，bun 的 summary 会整体缺失，filter 只能退化成日志片段，
    // 真实原因（退出码 / 信号 / ETIMEDOUT / ENOBUFS）随 e.status、e.signal、e.message 一起被丢弃。
    // 这里把失败判据显式前置，使其不被测试日志淹没。status/signal 均为 null 而 exit code 非 0 时，
    // 说明子进程被信号杀死（如 OOM 的 SIGKILL）。
    const diagnosis =
      `[${step.name}] ${e.message ?? "step failed"} | status=${e.status ?? "-"} signal=${e.signal ?? "-"}` +
      ` stdout=${(e.stdout ?? "").length}ch stderr=${(e.stderr ?? "").length}ch`;
    const filtered = step.filter(combined);
    return { ok: false, output: [diagnosis, filtered].filter(Boolean).join("\n\n"), ms };
  }
}

// --- main ---

if (process.argv.includes("--list")) {
  for (const step of STEPS) console.log(step.name);
  process.exit(0);
}

const totalStart = Date.now();
let allPassed = true;

for (const step of STEPS) {
  const { ok, output, ms } = runStep(step);

  const icon = ok ? "✓" : "✗";
  const tag = ok ? "" : " FAILED";
  console.log(`${icon} ${step.name} (${ms}ms)${tag}`);

  if (output) {
    // 缩进输出，跟步骤名区分开
    for (const line of output.split("\n")) {
      console.log(`  ${line}`);
    }
  }

  if (!ok) allPassed = false;
}

const totalMs = Date.now() - totalStart;
console.log(`\n${allPassed ? "✓ All passed" : "✗ Some steps failed"} (${totalMs}ms)`);
process.exit(allPassed ? 0 : 1);
