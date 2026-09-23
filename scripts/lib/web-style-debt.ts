/**
 * Web 样式存量台账（棘轮）。
 *
 * 样式禁止行为在仓库里已有数百处存量（`text-[Npx]` 数百、任意 `[&...]` 数百），一次性清零不现实，
 * 所以门禁只阻断**新增**：台账按「规则 + 目录」登记存量命中数，命中数只允许下降。
 *
 * 与架构例外台账（`scripts/lib/architecture-exceptions.ts`）的两点差异，都是刻意的：
 *
 * 1. **带计数，且下降不失败**。架构台账的条目是「一处结构性违规」，清掉一条就少一条，所以
 *    「条目不再违规」必须报错要求删除。样式存量以百处计、按目录成簇清理，若每次清理都强制改台账，
 *    维护者会倾向于不动它——这不是我们想要的激励。这里取严格单调方向：**涨了就失败，降了只提示**。
 * 2. **粒度是目录不是文件**。同一目录内的样式债同质（同一批组件的写法），逐文件登记只会让台账变成
 *    文件清单；目录粒度在「新增即失败」上等价，条目数少一个量级。
 *
 * 代价（据实记录）：目录粒度 + 计数意味着「同目录内删一处、加一处」不会被拦住。这层残留风险由
 * code review 兜底，换取的是台账可读、可维护。需要更强约束时应改成文件粒度，而不是在这里加规则。
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";

import { WEB_STYLE_RULES, type WebStyleRuleId, type WebStyleViolation } from "./web-style-rules";

const debtEntrySchema = z.strictObject({
  rule: z.enum(WEB_STYLE_RULES.map((rule) => rule.id) as [WebStyleRuleId, ...WebStyleRuleId[]]),
  directory: z.string().min(1),
  count: z.number().int().nonnegative(),
  owner: z.string().min(1),
});

const debtFileSchema = z.strictObject({
  // JSON 不能写注释，但台账需要一处解释语义与 owner 取值的地方，否则维护者只能翻脚本。
  _comment: z.array(z.string()).optional(),
  exceptions: z.array(debtEntrySchema),
});

export type WebStyleDebtEntry = z.infer<typeof debtEntrySchema>;

/** 未排期清理任务的默认归属；清理立项后应改成任务编号。 */
export const DEFAULT_WEB_STYLE_OWNER = "未排期";

/** 台账默认位置。 */
export const WEB_STYLE_DEBT_PATH = "scripts/web-style/exceptions.json";

/**
 * 台账的 `_comment`。由写入方（`scripts/check-web-style.ts --write-baseline`）统一落盘，
 * 保证「文件里写着什么」与「脚本按什么判定」不会各说各话；条目本身可以手改，格式由脚本规范化。
 */
export const WEB_STYLE_DEBT_COMMENT = [
  "Web 样式存量台账（棘轮）：按「规则 + 目录」登记存量命中数，由 scripts/check-web-style.ts 生成与校验。",
  "语义：台账里没有的「规则 + 目录」组合只要出现命中就失败（新增）；已登记组合的命中数上升同样失败；",
  "命中数下降不失败（只提示同步台账）——棘轮方向是「只降不升」，清理时不必为此改本文件。",
  "owner 取值：承接清理的任务编号，或显式的「未排期」；不得保留已结项任务号。",
  "条目移除条件：该目录在该规则下的命中清零后删除该条（重跑 --write-baseline 会自动归零）。",
  "生成方式：bun run check:web-style --write-baseline（只允许调低计数或删条目）。",
  "抬高基线必须显式加 --force，用于首次建基线或录入新纳入扫描范围的存量，须在 review 中说明理由。",
  "规则定义与真实反例：docs/developer/guide/forbidden-code-patterns.md。",
] as const;

/** 违规指纹：同一规则下同一目录只登记一次。 */
export function debtFingerprint(rule: string, directory: string): string {
  return `${rule} ${directory}`;
}

/** 违规所在目录（不含文件名）。 */
export function directoryOf(filePath: string): string {
  const segments = filePath.split("/");
  segments.pop();
  return segments.join("/") || ".";
}

/** 目录 + 规则分组；键与 `debtFingerprint` 一致。 */
export function groupViolationsByDirectory(
  violations: readonly WebStyleViolation[],
): Map<string, { rule: WebStyleRuleId; directory: string; violations: WebStyleViolation[] }> {
  const groups = new Map<string, { rule: WebStyleRuleId; directory: string; violations: WebStyleViolation[] }>();

  for (const violation of violations) {
    const directory = directoryOf(violation.filePath);
    const key = debtFingerprint(violation.ruleId, directory);
    const group = groups.get(key) ?? { rule: violation.ruleId, directory, violations: [] };
    group.violations.push(violation);
    groups.set(key, group);
  }

  return groups;
}

/** 按当前违规生成台账条目，用于初始化或重写基线。 */
export function buildWebStyleDebt(
  violations: readonly WebStyleViolation[],
  owner: string = DEFAULT_WEB_STYLE_OWNER,
): WebStyleDebtEntry[] {
  return [...groupViolationsByDirectory(violations).values()]
    .map((group) => ({
      rule: group.rule,
      directory: group.directory,
      count: group.violations.length,
      owner,
    }))
    .sort((left, right) => left.rule.localeCompare(right.rule) || left.directory.localeCompare(right.directory));
}

/** 加载后的台账；`entries` 以指纹为键。 */
export interface WebStyleDebtLedger {
  readonly entries: ReadonlyMap<string, WebStyleDebtEntry>;
}

const EMPTY_LEDGER: WebStyleDebtLedger = { entries: new Map() };

/**
 * 读取并校验台账。
 *
 * 指纹重复、规则 id 非法或结构不符都会直接抛错——「看起来有登记、实际不生效」的条目比没有条目更危险。
 * 文件缺失时返回空台账：此时「没有任何已登记存量」正是期望语义（所有命中按新增处理），
 * 这个降级方向更严格，不会放宽门禁。
 */
export async function loadWebStyleDebt(
  repositoryRoot: string,
  relativePath: string = WEB_STYLE_DEBT_PATH,
): Promise<WebStyleDebtLedger> {
  let source: string;
  try {
    source = await readFile(resolve(repositoryRoot, relativePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_LEDGER;
    throw error;
  }

  const parsed = debtFileSchema.safeParse(JSON.parse(source));
  if (!parsed.success) {
    throw new Error(`Web 样式存量台账格式非法: ${relativePath}`, { cause: parsed.error });
  }

  const entries = new Map<string, WebStyleDebtEntry>();
  for (const entry of parsed.data.exceptions) {
    const fingerprint = debtFingerprint(entry.rule, entry.directory);
    if (entries.has(fingerprint)) throw new Error(`Web 样式存量台账重复登记: ${fingerprint}`);
    entries.set(fingerprint, entry);
  }

  return { entries };
}

/** 台账比对结果。`unregistered` 与 `increases` 都必须阻断，`decreases` 只提示。 */
export interface WebStyleDebtComparison {
  unregistered: { rule: WebStyleRuleId; directory: string; violations: WebStyleViolation[] }[];
  increases: { entry: WebStyleDebtEntry; actual: number; violations: WebStyleViolation[] }[];
  decreases: { entry: WebStyleDebtEntry; actual: number }[];
  /** 台账登记的存量命中总数，用于成功输出里的「存量 N 处」。 */
  registeredTotal: number;
}

/** 用当前违规比对台账，得出新增 / 上升 / 下降三组结论。 */
export function compareWebStyleDebt(
  violations: readonly WebStyleViolation[],
  ledger: WebStyleDebtLedger,
): WebStyleDebtComparison {
  const groups = groupViolationsByDirectory(violations);
  const unregistered: WebStyleDebtComparison["unregistered"] = [];
  const increases: WebStyleDebtComparison["increases"] = [];

  for (const [fingerprint, group] of groups) {
    const entry = ledger.entries.get(fingerprint);
    if (!entry) {
      unregistered.push({ rule: group.rule, directory: group.directory, violations: group.violations });
      continue;
    }
    if (group.violations.length > entry.count) {
      increases.push({ entry, actual: group.violations.length, violations: group.violations });
    }
  }

  const decreases = [...ledger.entries]
    .map(([fingerprint, entry]) => ({ entry, actual: groups.get(fingerprint)?.violations.length ?? 0 }))
    .filter(({ entry, actual }) => actual < entry.count);

  return {
    unregistered: unregistered.sort(byLocation),
    increases: increases.sort((left, right) => left.entry.directory.localeCompare(right.entry.directory)),
    decreases: decreases.sort((left, right) => left.entry.directory.localeCompare(right.entry.directory)),
    registeredTotal: [...ledger.entries.values()].reduce((total, entry) => total + entry.count, 0),
  };
}

function byLocation(
  left: { rule: WebStyleRuleId; directory: string },
  right: { rule: WebStyleRuleId; directory: string },
): number {
  return left.rule.localeCompare(right.rule) || left.directory.localeCompare(right.directory);
}
