import { expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

/**
 * 两个入口的静态清单：写盘修复 + 11 条静态门禁，类型检查器是唯一检查器 `tsc-rs`。
 * 这里是**故意硬编码**的期望值——它要能在「某条门禁只接进 precheck」或「某个入口换回别的检查器」时失败，
 * 而不是跟着实现一起漂移（全量切 `tsc-rs` 的取舍与平台限制见 `scripts/lib/check-gates.ts` 头部）。
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
  "tsc-rs (server)",
  "tsc-rs (web)",
  "tsc-rs (packages)",
  "dependency-boundaries",
];

/** 预发布的三批全量测试；fastcheck 按变更影响范围只取其中若干批。 */
const TEST_BATCH_NAMES = ["server-and-script-tests", "package-tests", "web-app-tests"];

/** 以真实 CLI 形态取步骤清单（`--list` 在探活与跑任何步骤之前就退出）。 */
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

// 快检与预发布共用同一份静态步骤定义与同一个检查器：任何一条门禁只接进其中一边都会在这里失败。
test("fastcheck 与 precheck 的静态清单逐字同源，唯一检查器是 tsc-rs", async () => {
  const [fastcheckSteps, precheckSteps] = await Promise.all([
    listSteps("scripts/fastcheck.ts"),
    listSteps("scripts/ci.ts"),
  ]);

  expect(fastcheckSteps).toEqual(STATIC_STEP_NAMES);
  expect(precheckSteps).toEqual([...STATIC_STEP_NAMES, ...TEST_BATCH_NAMES]);
});
