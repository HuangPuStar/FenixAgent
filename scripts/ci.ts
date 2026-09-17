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
    cmd: "biome format --write apps/server/src/ apps/ packages/ scripts/ docs/.vitepress/",
    filter: (out: string) => {
      if (out.includes("No fixes applied") || out.includes("Formatted")) return null;
      return out;
    },
  },
  {
    name: "import-sort",
    cmd: "biome check --write --linter-enabled=false apps/server/src/ apps/ packages/ scripts/ docs/.vitepress/",
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
    name: "architecture",
    cmd: "bun run architecture:check",
    filter: (out: string) => (out.includes("✓ architecture-check") ? null : out),
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
    name: "dependency-boundaries",
    cmd: "bun run check:dependencies",
    filter: (out: string) => (out.includes("no dependency violations") ? null : out),
  },
  {
    name: "lint",
    cmd: "biome check apps/server/src/ apps/ packages/ scripts/ docs/.vitepress/",
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
    cmd: "bun test packages/ 2>&1",
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
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ms = Date.now() - start;
    return { ok: true, output: step.filter(raw), ms };
  } catch (err: unknown) {
    const ms = Date.now() - start;
    const e = err as { stdout?: string; stderr?: string; status?: number };
    const combined = [e.stdout ?? "", e.stderr ?? ""].join("\n");
    return { ok: false, output: step.filter(combined), ms };
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
