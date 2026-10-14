/**
 * precheck — **预发布全量门禁**（发布前必须全绿）。单任务收尾的快检见 `scripts/fastcheck.ts`。
 *
 * **三波结构**（波内受限并发，执行语义见 `scripts/lib/check-runner.ts`，步骤目录见 `check-gates.ts`）：
 * 1. 写盘修复：`biome check --write`，单步串行——后续所有门禁都读同一批文件，它必须先完成。
 * 2. 静态门禁：生成物、架构、依赖边界、类型检查（`tsc-rs` ×3）——互不依赖，按耗时降序受限并发。
 * 3. 测试：三批**全量** `bun test`。
 *
 * **定位**：本命令回答「能不能发布」。它不追求快——全量测试（实测 890 个测试文件 / 10450 个用例）
 * 本身就是耗时下限，不要为了缩短它而削弱覆盖；日常迭代与单任务收尾用 `bun run fastcheck`。
 *
 * **为什么分波而不是全串行**：原实现 18 步逐个 `execSync`，wall 是各步耗时之和；类型检查当时就占其中约
 * 70s。其中 `tsc (app skeletons)` 的 web 半边与 `tsc (web)` **逐字重复**、server 半边是根 `tsc` 的文件子集
 * （两者同继承 `tsconfig.base.json`，include 亦被根配置覆盖），该步骤已删除；其余互不依赖的步骤改为并发，
 * wall 由同波最慢的步骤决定。
 *
 * **为什么 biome 只跑一遍**：`biome check --write` 一次完成格式化、import 排序与**安全修复**，且修复后
 * 仍有 error 时退出码为 1、只有 warning 时为 0——原实现的三遍（`format --write` →
 * `check --write --linter-enabled=false` → `check`）等价于此，只是把同一批文件扫了三遍。行为的唯一差异
 * 是安全修复现在会就地生效（此前仅格式与 import 排序会），这正是「格式/lint 自动修复」的原意。
 *
 * **为什么测试单独一波**：三批全量 `bun test` 是整套门禁里唯一的重活，静态门禁（`tsc-rs` 之后）只要
 * 十几秒；合并成一波只省下这点时间，却会让测试与静态门禁的峰值负载叠加——仓库里已有「并行负载下偶发
 * 失败」的记录（`round37-service-boundaries.test.ts` 的 sandbox 补偿边界）。分开跑用十几秒的 wall 换结果稳定。
 */

import { exitIfTypeCheckerUnavailable, STATIC_GATES, TEST_BATCHES } from "./lib/check-gates";
import { BIOME_STEP, isListRequested, printStepList, runWaves, type Wave } from "./lib/check-runner";

const WAVES: readonly Wave[] = [
  // 写盘阶段必须独占：它改动文件，后面所有步骤都读文件。
  { concurrency: 1, steps: [BIOME_STEP] },
  { concurrency: 6, steps: STATIC_GATES },
  { concurrency: 3, steps: TEST_BATCHES },
];

if (isListRequested()) {
  printStepList(WAVES.flatMap((wave) => wave.steps));
  process.exit(0);
}

await exitIfTypeCheckerUnavailable();

process.exit((await runWaves(WAVES)) ? 0 : 1);
