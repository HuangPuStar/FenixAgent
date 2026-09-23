/**
 * Web 样式禁止行为门禁（`FCP-WEB-01/02/03`）。
 *
 * 规则与反例见 `docs/developer/guide/forbidden-code-patterns.md`，检测核心在
 * `scripts/lib/web-style-rules.ts`。本文件只负责：遍历扫描范围 → 加载存量台账 → 阻断新增 → 输出证据。
 *
 * 判定：
 * - 台账里**没有**的「规则 + 目录」组合出现命中 → 失败（新增违规）。
 * - 已登记组合的命中数**上升** → 失败（棘轮只降不升）。
 * - 命中数下降 / 清零 → 不失败，仅提示同步台账。
 *
 * 用法：
 * ```
 * bun run check:web-style                            # 门禁，失败返回 1
 * bun run check:web-style --write-baseline           # 同步台账：只允许调低计数或删条目（清理后重跑，零摩擦）
 * bun run check:web-style --write-baseline --force   # 首次建基线、或确需抬高时显式放行（须在 review 中说明）
 * ```
 *
 * 为什么「抬高基线」必须显式 `--force`：生成器如果默认接受当前状态，一条命令就能把新增违规洗成存量，
 * 门禁会变成摆设。因此安全方向（下降）零摩擦，危险方向（上升）留痕。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildWebStyleDebt,
  compareWebStyleDebt,
  debtFingerprint,
  loadWebStyleDebt,
  WEB_STYLE_DEBT_COMMENT,
  WEB_STYLE_DEBT_PATH,
  type WebStyleDebtComparison,
  type WebStyleDebtEntry,
  type WebStyleDebtLedger,
} from "./lib/web-style-debt";
import {
  findWebStyleViolations,
  WEB_STYLE_RULES,
  WEB_STYLE_RULES_DOC,
  type WebStyleViolation,
} from "./lib/web-style-rules";

const repositoryRoot = resolve(import.meta.dir, "..");

/** 扫描范围：宿主 web 应用与各 owner 包的 web 面——即 Tailwind `@source` 覆盖的那批源码。 */
const SCAN_PATTERNS = ["apps/web/src/**/*", "packages/**/web/**/*"] as const;
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const EXCLUDED_SEGMENTS = ["node_modules", "dist", "__tests__"] as const;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** 单个目录最多打印的样例条数：证据用于定位写法，不需要把上百行都倒出来。 */
const SAMPLES_PER_DIRECTORY = 3;

/** 门禁选项；`root` 可注入，供自测构造独立工作区。 */
export interface WebStyleCheckOptions {
  root?: string;
  writeBaseline?: boolean;
  force?: boolean;
}

/** 列出扫描范围内的源文件（仓库相对、POSIX、去重排序）。 */
export async function listWebStyleFiles(root: string = repositoryRoot): Promise<string[]> {
  const files = new Set<string>();

  for (const pattern of SCAN_PATTERNS) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, dot: false, onlyFiles: true })) {
      const relativePath = path.replaceAll("\\", "/");
      if (!SOURCE_EXTENSIONS.some((extension) => relativePath.endsWith(extension))) continue;
      if (TEST_FILE_PATTERN.test(relativePath)) continue;
      if (relativePath.split("/").some((segment) => EXCLUDED_SEGMENTS.some((excluded) => segment === excluded))) {
        continue;
      }
      files.add(relativePath);
    }
  }

  return [...files].sort();
}

/** 扫描全部目标文件并返回命中，按「规则 → 路径 → 行」排序，保证输出稳定可 diff。 */
export async function collectWebStyleViolations(root: string = repositoryRoot): Promise<WebStyleViolation[]> {
  const violations: WebStyleViolation[] = [];

  for (const relativePath of await listWebStyleFiles(root)) {
    const source = await Bun.file(resolve(root, relativePath)).text();
    violations.push(...findWebStyleViolations(relativePath, source));
  }

  return violations.sort(
    (left, right) =>
      left.ruleId.localeCompare(right.ruleId) ||
      left.filePath.localeCompare(right.filePath) ||
      left.line - right.line ||
      left.column - right.column,
  );
}

/** 打印一处命中：`路径:行:列  token`，可直接跳到现场。 */
function formatViolation(violation: WebStyleViolation): string {
  return `${violation.filePath}:${violation.line}:${violation.column}  ${violation.token}`;
}

function ruleTitle(ruleId: string): string {
  return WEB_STYLE_RULES.find((rule) => rule.id === ruleId)?.title ?? ruleId;
}

/** 打印新增违规：按目录归并，每个目录给少量样例。 */
function reportUnregistered(unregistered: WebStyleDebtComparison["unregistered"]): void {
  const total = unregistered.reduce((sum, group) => sum + group.violations.length, 0);
  console.error(`✗ web-style 新增 ${total} 处未登记违规（规则见 ${WEB_STYLE_RULES_DOC}）：`);

  for (const group of unregistered) {
    console.error(`  [${group.rule}] ${ruleTitle(group.rule)} · ${group.directory}（${group.violations.length} 处）`);
    for (const violation of group.violations.slice(0, SAMPLES_PER_DIRECTORY)) {
      console.error(`    ${formatViolation(violation)}`);
    }
    if (group.violations.length > SAMPLES_PER_DIRECTORY) {
      console.error(`    … 另有 ${group.violations.length - SAMPLES_PER_DIRECTORY} 处`);
    }
  }
}

/** 打印棘轮被突破的目录。 */
function reportIncreases(increases: WebStyleDebtComparison["increases"]): void {
  console.error(`✗ web-style 有 ${increases.length} 个目录超出登记数（棘轮只允许下降）：`);

  for (const { entry, actual, violations } of increases) {
    console.error(`  [${entry.rule}] ${entry.directory}  记录 ${entry.count} 处，实际 ${actual} 处`);
    for (const violation of violations.slice(-SAMPLES_PER_DIRECTORY)) {
      console.error(`    ${formatViolation(violation)}`);
    }
  }
}

/** 提示可以同步下调的台账条目；不影响退出码。 */
function reportDecreases(decreases: WebStyleDebtComparison["decreases"]): void {
  if (decreases.length === 0) return;

  console.log(`  存量台账有空档可收（${decreases.length} 条已低于登记数，重跑 --write-baseline 会同步）：`);
  for (const { entry, actual } of decreases) {
    console.log(`    [${entry.rule}] ${entry.directory}  记录 ${entry.count} 处，实际 ${actual} 处`);
  }
}

/** 把当前存量写进台账；默认只允许「下降」，新增条目或调高计数都必须显式 `--force`。 */
async function writeBaseline(
  root: string,
  violations: readonly WebStyleViolation[],
  ledger: WebStyleDebtLedger,
  force: boolean,
): Promise<number> {
  const entries = buildWebStyleDebt(violations);
  // 安全的写入方向只有「下降」：清掉存量后重跑基线应当零摩擦，而抬高基线必须是显式动作——
  // 否则一次生成命令就能把新增违规洗成存量，门禁形同虚设。
  const raised: { entry: WebStyleDebtEntry; recorded: WebStyleDebtEntry | null }[] = [];
  for (const entry of entries) {
    const recorded = ledger.entries.get(debtFingerprint(entry.rule, entry.directory));
    if (recorded === undefined) raised.push({ entry, recorded: null });
    else if (recorded.count < entry.count) raised.push({ entry, recorded });
  }

  if (raised.length > 0 && !force) {
    console.error(`✗ 拒绝抬高基线：${raised.length} 个「规则 + 目录」是新增或计数上升，基线只能录存量：`);
    for (const { entry, recorded } of raised) {
      console.error(
        `  [${entry.rule}] ${entry.directory}  ${recorded === null ? "未登记" : `记录 ${recorded.count} 处`}，当前 ${entry.count} 处`,
      );
    }
    console.error("请先清理这些新增写法；确需调高时显式加 --force，并在 review 中说明理由。");
    return 1;
  }

  const path = resolve(root, WEB_STYLE_DEBT_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ _comment: WEB_STYLE_DEBT_COMMENT, exceptions: entries }, null, 2)}\n`,
    "utf8",
  );

  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  console.log(`已写入 ${WEB_STYLE_DEBT_PATH}：${entries.length} 条、${total} 处存量命中。`);
  return 0;
}

/** 执行门禁并返回进程退出码；`--write-baseline` 时改写台账而不是判定。 */
export async function checkWebStyle(options: WebStyleCheckOptions = {}): Promise<number> {
  const root = options.root ?? repositoryRoot;
  const violations = await collectWebStyleViolations(root);
  const ledger = await loadWebStyleDebt(root);

  if (options.writeBaseline) return writeBaseline(root, violations, ledger, options.force ?? false);

  const comparison = compareWebStyleDebt(violations, ledger);
  if (comparison.unregistered.length === 0 && comparison.increases.length === 0) {
    console.log(`✓ web-style  （已登记存量 ${comparison.registeredTotal} 处，本次零新增）`);
    reportDecreases(comparison.decreases);
    return 0;
  }

  if (comparison.unregistered.length > 0) reportUnregistered(comparison.unregistered);
  if (comparison.increases.length > 0) reportIncreases(comparison.increases);

  console.error("修法：尺寸/颜色改用标准刻度或 token；深层样式下沉为 CSS 类；响应式改用规范断点。");
  console.error("台账只登记存量：确属待清理的历史写法才有条目，新增写法一律现场修掉。");
  return 1;
}

/** 解析命令行参数；未知参数直接报错，避免拼错标志后静默跑成「检查」。 */
export function parseArgs(argv: readonly string[]): WebStyleCheckOptions {
  const options: WebStyleCheckOptions = {};

  for (const argument of argv) {
    if (argument === "--write-baseline") options.writeBaseline = true;
    else if (argument === "--force") options.force = true;
    else throw new Error(`未知参数: ${argument}（可用：--write-baseline、--force）`);
  }

  return options;
}

if (import.meta.main) {
  process.exit(await checkWebStyle(parseArgs(process.argv.slice(2))));
}
