/**
 * fastcheck — **agent 完成单任务后的快检**。预发布全量门禁见 `scripts/ci.ts`（precheck）。
 *
 * 与 precheck 的唯一差别是**测试范围**：这里只跑本次改动影响到的部分（`scripts/lib/affected-tests.ts`），
 * precheck 跑三批全量。静态门禁（含类型检查）与 precheck **共用同一份步骤定义与同一个检查器**
 * （`scripts/lib/check-gates.ts`，`tsc-rs`），不会出现「某条门禁只在预发布里接线」或「两边口径不同」的分叉；
 * `--no-tests` 关闭测试波，退化成纯静态快检。
 *
 * **不要用它替代 precheck**：影响范围判定刻意不含宿主消费方的反向依赖闭包，宿主侧集成回归只有 precheck
 * 的三批全量测试能覆盖。发布前必须 `bun run precheck` 全绿。
 */

import { collectChangedPaths, loadWorkspacePackages, resolveAffectedTests } from "./lib/affected-tests";
import { exitIfTypeCheckerUnavailable, STATIC_GATES } from "./lib/check-gates";
import { BIOME_STEP, isListRequested, printStepList, runWaves, type Wave } from "./lib/check-runner";

const STATIC_STEPS = [BIOME_STEP, ...STATIC_GATES];

if (isListRequested()) {
  printStepList(STATIC_STEPS);
  process.exit(0);
}

await exitIfTypeCheckerUnavailable();

const skipTests = process.argv.includes("--no-tests");
const waves: Wave[] = [
  // 写盘阶段必须独占：它改动文件，后面所有步骤都读文件。
  { concurrency: 1, steps: [BIOME_STEP] },
  { concurrency: 6, steps: STATIC_GATES },
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
