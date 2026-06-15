/**
 * CI 全通过脚本 — 只输出有用的信息。
 *
 * 步骤：biome format → biome check (import 排序) → tsc → biome lint → bun test
 * 格式/lint 自动修复，类型检查和测试只报告失败项。
 */

import { execSync } from "node:child_process";

const STEPS = [
  {
    name: "format",
    cmd: "biome format --write src/ web/src/ web/components/ packages/ scripts/ docs/.vitepress/",
    filter: (out: string) => {
      if (out.includes("No fixes applied") || out.includes("Formatted")) return null;
      return out;
    },
  },
  {
    name: "import-sort",
    cmd: "biome check --write --linter-enabled=false src/ web/src/ web/components/ packages/ scripts/ docs/.vitepress/",
    filter: (out: string) => {
      if (out.includes("No fixes applied") || out.includes("Checked")) return null;
      return out;
    },
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
    cmd: "cd web && tsc --noEmit",
    filter: (out: string) => {
      const errors = out.split("\n").filter((l) => l.includes("error TS"));
      return errors.length > 0 ? errors.join("\n") : null;
    },
  },
  {
    name: "lint",
    cmd: "biome check src/ web/src/ web/components/ packages/ scripts/ docs/.vitepress/",
    filter: (out: string) => {
      if (out.includes("Checked") && !out.includes("error") && !out.includes("warning")) return null;
      // 只保留有问题的文件行
      const lines = out.split("\n").filter((l) => !l.match(/^Checked\s/) && l.trim() !== "");
      return lines.length > 0 ? lines.join("\n") : null;
    },
  },
  {
    name: "test",
    cmd: "bun test src/__tests__/ 2>&1",
    filter: (out: string) => {
      const lines = out.split("\n");

      // 提取汇总行
      const summary = lines.filter((l) => /^\s*\d+ (pass|fail|skip)/.test(l) || /^Ran /.test(l));

      // 提取失败测试
      const failedTests: string[] = [];
      let inFailBlock = false;
      for (const line of lines) {
        if (line.includes("(fail)")) {
          inFailBlock = true;
          failedTests.push(line.trim());
        } else if (inFailBlock && line.trim() === "") {
          inFailBlock = false;
        } else if (inFailBlock) {
          // 失败测试的错误详情（diff、at 行等）
          if (
            line.includes("error:") ||
            line.startsWith(" ") ||
            line.startsWith("+") ||
            line.startsWith("-") ||
            line.startsWith("at ")
          ) {
            failedTests.push(line);
          }
        }
      }

      if (failedTests.length > 0) {
        return [...failedTests, "", ...summary].join("\n");
      }
      return summary.length > 0 ? summary.join("\n") : null;
    },
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
