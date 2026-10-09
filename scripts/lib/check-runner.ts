/**
 * 门禁步骤的共享执行器：`scripts/ci.ts`（precheck，预发布全量）与 `scripts/fastcheck.ts`
 * （单任务快检）共用同一套「波次 + 受限并发 + 输出过滤」的实现。
 *
 * **为什么单独成模块**：在 fastcheck 出现之前只有一个消费方，执行逻辑内联在 `ci.ts` 里是对的；
 * 现在有两个真实用例（同一套并发/超时/输出上限/失败诊断语义必须一致），复制一份会让两边悄悄漂移——
 * 例如「error 才失败」「超时按失败处理」这类判定一旦分叉，快检就会给出与预发布不同的结论。
 *
 * **执行语义**（两个入口都不许另立一套）：
 * - 步骤经 `sh -c` 执行，命令行与 `package.json` 脚本、husky 钩子保持同一种写法；
 * - 单步超时 `STEP_TIMEOUT_MS`，到达即 SIGKILL 并按失败处理，避免整个门禁挂死；
 * - 单路输出上限 `MAX_STREAM_BYTES`，超出丢弃并留截断标记（仍继续排空管道，避免子进程被阻塞）；
 * - 失败诊断首行固定是 `[步骤名] 状态 | status/signal/stdout/stderr`，真实原因不被日志淹没；
 * - 波内按 `weight` 降序启动（重的先占槽位），`--list` 与打印仍按声明顺序。
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/**
 * tsc 增量缓存目录。放在 `node_modules/` 下有三个原因：天然被 git 忽略（无需新 .gitignore 条目）、
 * 不落在任何生成物门禁的扫描面内、被视为可随时丢弃的构建缓存。缓存有效性由 tsc 按文件版本
 * （mtime + size）与配置哈希判定：删掉整个目录只会让下一次运行变慢，不会造成漏检。
 */
export const TSC_BUILD_INFO_DIR = join(REPOSITORY_ROOT, "node_modules", ".cache", "fenix-precheck");

/** 单个步骤的超时上限；到达后终止该步骤并按失败处理，避免门禁整体挂死。 */
const STEP_TIMEOUT_MS = 300_000;

/** 单路输出上限（与旧 `execSync` 的 maxBuffer 同量级），超出部分丢弃并留下截断标记。 */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

/** biome 扫描面：与旧实现的两遍写盘步骤逐字一致（旧 lint 步骤用的也是同一批路径）。 */
export const BIOME_PATHS = "apps/server/src/ apps/ packages/ scripts/ db/ docs/.vitepress/";

/** biome 输出中的纯进度行：既不构成失败依据，也不需要在结果中复述。 */
const BIOME_NOISE =
  /^(?:Checked|Formatted|Fixed) \d|^No fixes applied|^Skipped \d+ suggested fixes|^If you wish to apply/;

export interface Step {
  readonly name: string;
  /** 经 `sh -c` 执行，保持与 package.json 脚本、husky 钩子同一套命令写法。 */
  readonly cmd: string;
  readonly filter: (out: string) => string | null;
  /**
   * 同波内的启动顺序权重，取实测耗时量级（毫秒）。受限并发下先启动最重的步骤，wall 更接近理论下界；
   * 它只影响启动顺序，不影响判定——填错只会让某种排序下慢几秒，不会漏检任何步骤。
   */
  readonly weight: number;
}

export interface Wave {
  readonly concurrency: number;
  readonly steps: readonly Step[];
}

export interface StepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly output: string | null;
  readonly ms: number;
}

/** `--noEmit --incremental` 的公共参数：缓存文件按调用方给定的名字落进 `TSC_BUILD_INFO_DIR`。 */
export function tscIncrementalArgs(name: string): string {
  return `--incremental --tsBuildInfoFile ${join(TSC_BUILD_INFO_DIR, `${name}.tsbuildinfo`)}`;
}

/** 写盘修复步骤：`biome check --write` 一次完成格式化、import 排序与安全修复。 */
export const BIOME_STEP: Step = {
  name: "biome",
  cmd: `biome check --write ${BIOME_PATHS}`,
  filter: filterBiome,
  weight: 800,
};

/** tsc 诊断行过滤：只保留错误行（`path(12,3): error TS1234` 或 `path:12:3 - error TS1234`）。 */
export function filterTsc(out: string): string | null {
  const errors = out.split("\n").filter((line) => line.includes("error TS"));
  return errors.length > 0 ? errors.join("\n") : null;
}

/**
 * biome 结果过滤：只有出现 error / warning 才值得复述；info 级诊断与「已修复」进度行不构成门禁依据。
 * 退出码仍是失败判据（error → 1），这里只决定失败或告警时打印什么。
 */
export function filterBiome(out: string): string | null {
  if (!/\berror\b|\bwarning\b/i.test(out)) return null;
  const lines = out.split("\n").filter((line) => line.trim() !== "" && !BIOME_NOISE.test(line));
  return lines.length > 0 ? lines.join("\n") : null;
}

/** 生成器类步骤统一输出 `✓ <name>`；已同步时静默，漂移时才打印差异。 */
export function filterVerified(marker: string): (out: string) => string | null {
  return (out) => (out.includes(marker) ? null : out);
}

/**
 * 读取子进程的一路输出，超过上限即停止累积（仍继续排空管道，避免子进程被填满的管道阻塞）。
 * 分块解码用流式 `TextDecoder`，防止多字节字符被切在块边界上。
 */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (bytes >= MAX_STREAM_BYTES) {
        truncated = true;
        continue;
      }
      bytes += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  chunks.push(decoder.decode());
  return { text: chunks.join(""), truncated };
}

/** 执行单个步骤并返回结果；超时按失败处理，诊断里保留被终止这一事实。 */
export async function runStep(step: Step): Promise<StepResult> {
  const started = Date.now();
  const proc = Bun.spawn(["sh", "-c", step.cmd], {
    cwd: REPOSITORY_ROOT,
    // 显式前置 `node_modules/.bin`（biome / tsc）与 bun 自身所在目录：`bun run precheck` 会注入这两项，
    // 但 `bun scripts/ci.ts` 直接调用时不会，命令写法两边都要能用。
    env: {
      ...process.env,
      PATH: [join(REPOSITORY_ROOT, "node_modules", ".bin"), dirname(process.execPath), process.env.PATH ?? ""].join(
        ":",
      ),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, STEP_TIMEOUT_MS);

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]).finally(() => clearTimeout(timer));

  const ms = Date.now() - started;
  const combined = [stdout.text, stderr.text].filter((text) => text !== "").join("\n");
  const truncated = stdout.truncated || stderr.truncated;
  const ok = exitCode === 0 && !timedOut;
  const filtered = step.filter(combined);

  if (ok) {
    return {
      name: step.name,
      ok: true,
      output: [filtered, truncated ? "[输出超过上限，已截断]" : null].filter(Boolean).join("\n") || null,
      ms,
    };
  }

  // 进程被信号终止、超时或输出溢出时，bun 的 summary 会整体缺失，filter 只能退化成日志片段，
  // 真实原因（退出码 / 信号 / 超时）必须显式前置，才不会被测试日志淹没。
  const diagnosis =
    `[${step.name}] ${timedOut ? `步骤超过 ${STEP_TIMEOUT_MS}ms 被终止` : "步骤失败"}` +
    ` | status=${exitCode} signal=${proc.signalCode ?? "-"}` +
    ` stdout=${stdout.text.length}ch stderr=${stderr.text.length}ch`;
  return {
    name: step.name,
    ok: false,
    output: [diagnosis, truncated ? "[输出超过上限，已截断]" : null, filtered].filter(Boolean).join("\n\n"),
    ms,
  };
}

/** 打印单个步骤结果：步骤名 + 耗时 + 缩进后的诊断。 */
export function printResult(result: StepResult): void {
  console.log(`${result.ok ? "✓" : "✗"} ${result.name} (${result.ms}ms)${result.ok ? "" : " FAILED"}`);
  if (!result.output) return;
  for (const line of result.output.split("\n")) console.log(`  ${line}`);
}

/** 跑完一波：单线程游标分配任务，避免一次性拉起全部子进程；完成即打印，保持进度可见。 */
export async function runWave(wave: Wave): Promise<boolean> {
  // 按权重降序取任务：受限并发下先占住槽位的是最重的步骤，轻步骤随空出的槽位补齐。
  // 只排序执行顺序，`--list` 与打印顺序仍取声明顺序。
  const queue = [...wave.steps].sort((a, b) => b.weight - a.weight);
  let cursor = 0;
  let ok = true;

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const step = queue[cursor++];
      if (!step) continue;
      const result = await runStep(step);
      if (!result.ok) ok = false;
      printResult(result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(wave.concurrency, queue.length) }, worker));
  return ok;
}

/** 顺序跑完全部波次并打印总耗时；返回是否全绿（调用方据此决定退出码）。 */
export async function runWaves(waves: readonly Wave[]): Promise<boolean> {
  mkdirSync(TSC_BUILD_INFO_DIR, { recursive: true });

  const totalStart = Date.now();
  let allPassed = true;
  for (const wave of waves) {
    const wavePassed = await runWave(wave);
    if (!wavePassed) allPassed = false;
  }

  console.log(`\n${allPassed ? "✓ All passed" : "✗ Some steps failed"} (${Date.now() - totalStart}ms)`);
  return allPassed;
}

/** `--list` 支持：按声明顺序打印步骤名，供门禁接线测试断言（不执行任何步骤）。 */
export function isListRequested(): boolean {
  return process.argv.includes("--list");
}

export function printStepList(steps: readonly Step[]): void {
  for (const step of steps) console.log(step.name);
}
