import { expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

/**
 * 两个入口的静态清单（类型检查器归一化为官方 `tsc` 名字）：写盘修复 + 11 条静态门禁。
 * 这里是**故意硬编码**的期望值——它要能在「某条门禁只接进 precheck」时失败，而不是跟着实现一起漂移。
 */
const STATIC_STEP_NAMES = [
  "biome",
  "module-registry",
  "web-contributions",
  "owner-inventory",
  "schema-ddl-drift",
  "env-example",
  "architecture",
  "web-style",
  "tsc (server)",
  "tsc (web)",
  "tsc (packages)",
  "dependency-boundaries",
];

/** 预发布的三批全量测试；fastcheck 按变更影响范围只取其中若干批。 */
const TEST_BATCH_NAMES = ["server-and-script-tests", "package-tests", "web-app-tests"];

/** 以真实 CLI 形态取步骤清单（`--list` 在跑任何步骤前就退出）。 */
async function listSteps(script: string): Promise<string[]> {
  const child = Bun.spawn([process.execPath, resolve(ROOT, script), "--list"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return stdout.trim().split("\n");
}

/** 归一化类型检查器前缀：快检用 `tsc-rs`、预发布用 `tsc`——这是两者唯一允许的差异，其余必须逐字同名。 */
function normalizeChecker(name: string): string {
  return name.replace(/^tsc-rs /, "tsc ");
}

// 快检与预发布共用同一份静态步骤定义：任何一条门禁只接进 precheck（或只在 fastcheck 接线）都会在这里失败。
test("fastcheck 与 precheck 的静态清单同源，只有类型检查器不同", async () => {
  const [fastcheckSteps, precheckSteps] = await Promise.all([
    listSteps("scripts/fastcheck.ts"),
    listSteps("scripts/ci.ts"),
  ]);

  expect(fastcheckSteps.map(normalizeChecker)).toEqual(STATIC_STEP_NAMES);
  expect(precheckSteps).toEqual([...STATIC_STEP_NAMES, ...TEST_BATCH_NAMES]);

  // 检查器成组出现：装了 tsc-rs 就三步全用它（探活成功），没装就三步全回退官方 tsc；混用会掩盖某步未接线。
  const fastCheckers = new Set(fastcheckSteps.filter((name) => /^tsc/.test(name)).map((name) => name.split(" ")[0]));
  expect(fastCheckers.size).toBe(1);
  // 预发布门禁是发布判据，不得依赖 tsc-rs 这类实验检查器。
  expect(precheckSteps.some((name) => name.startsWith("tsc-rs"))).toBe(false);
});
