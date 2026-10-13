/**
 * fastcheck — **agent 完成单任务后的快检**。预发布全量门禁见 `scripts/ci.ts`（precheck）。
 *
 * 三层内容与 precheck 一致（先写盘修复，再静态门禁，最后测试），差别只有两处：
 * - 类型检查用 `tsc-rs`（同一批 tsconfig 与目标，本仓实测诊断与官方 `tsc` 逐字一致，冷启动快一个量级）；
 *   探活失败（未装 / 平台无二进制）即回退官方 `tsc`，并在开头打印一行说明；
 * - 测试只跑**本次改动影响到的范围**（`scripts/lib/affected-tests.ts`），而不是三批全量。
 *
 * 其余静态门禁与 precheck **共用同一份步骤定义**（`scripts/lib/check-gates.ts`），不会出现「某条门禁只在
 * 预发布里接线」的分叉；`--no-tests` 关闭测试波，退化成纯静态快检（约 10–15s）。
 *
 * **不要用它替代 precheck**：影响范围判定刻意不含宿主消费方的反向依赖闭包，宿主侧集成回归只有 precheck
 * 的三批全量测试能覆盖。发布前必须 `bun run precheck` 全绿。
 */

import { collectChangedPaths, loadWorkspacePackages, resolveAffectedTests } from "./lib/affected-tests";
import { FAST_STATIC_GATES, hasFastTypeChecker, STATIC_GATES } from "./lib/check-gates";
import { BIOME_STEP, isListRequested, printStepList, runWaves, type Wave } from "./lib/check-runner";

/**
 * 快检的静态部分：写盘修复 + 静态门禁。类型检查器在跑之前先探活——`tsc-rs` 只发布两种平台二进制，
 * 未装或平台不支持时必须能干净回退，否则快检在那些机器上直接不可用。
 */
const useFastTypeChecker = await hasFastTypeChecker();
const staticGates = useFastTypeChecker ? FAST_STATIC_GATES : STATIC_GATES;
const STATIC_STEPS = [BIOME_STEP, ...staticGates];

if (isListRequested()) {
  printStepList(STATIC_STEPS);
  process.exit(0);
}

console.log(
  useFastTypeChecker
    ? "· 类型检查：tsc-rs（快检口径；发布门禁 precheck 仍用官方 tsc）"
    : "· 类型检查：未检测到可运行的 tsc-rs，回退官方 tsc（安装：bun add -d tsc-rs）",
);

const skipTests = process.argv.includes("--no-tests");
const waves: Wave[] = [
  // 写盘阶段必须独占：它改动文件，后面所有步骤都读文件。
  { concurrency: 1, steps: [BIOME_STEP] },
  { concurrency: 6, steps: staticGates },
];

if (skipTests) {
  console.log("· 跳过测试（--no-tests）：仅静态门禁");
} else {
  const affected = resolveAffectedTests(collectChangedPaths(), loadWorkspacePackages());
  for (const note of affected.notes) console.log(`· ${note}`);

  if (affected.steps.length > 0) {
    waves.push({ concurrency: 3, steps: affected.steps });
  } else {
    console.log("· 本次改动无对应测试批次");
  }
}

process.exit((await runWaves(waves)) ? 0 : 1);
