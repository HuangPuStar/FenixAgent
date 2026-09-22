/**
 * 三份键值／参数编辑器（`InputsEditor` / `OutputsEditor` / `ParamsEditor`）行内字段的样式配方。
 *
 * 为什么共享：这些类串此前在三个编辑器里逐字重复——「键名输入框 + 键名为空时标红」3 处、
 * 「占满剩余宽度的字段」4 处（值 / 描述 / 数字默认值 / 字符串默认值）、「类型下拉」2 处。
 * 三者都是**成组出现的配方**（行高与字号一起出现，标红是「基础串 + 条件串」的组合），
 * 改行高或改标红配色时必须同批改完，共享后这个约束只落在一处。
 *
 * 刻意**不**收的邻近写法：
 * - `ParamsEditor` 的 JSON 默认值 `Textarea`（`flex-1 text-xs font-mono min-h-0 py-1`）——多行、
 *   等宽、可标红，是另一套配方，只出现 1 次；
 * - `OutputsEditor` / `ParamsEditor` 键名格的 `style={{ width: "28%" }}`（`InputsEditor` 是 30%，
 *   且 `OutputsEditor` 在 `value` 类型下要放开宽度）——列宽与「值单元格要不要占位」耦合，
 *   抽成常量会把每处不同的列宽判断搬到远处，收益为负。
 */

/** 键名／参数名输入框：紧凑行高；键名为空时标红，提示该行提交时会被丢弃。 */
export function entryKeyInputClass(invalidKey: boolean): string {
  return `h-8 text-xs${invalidKey ? " border-red-300 bg-red-50" : ""}`;
}

/** 键值行里占满剩余宽度的字段（值 / 描述 / 默认值）：同高同字号，与键名格并排成一行。 */
export const ENTRY_FIELD_CLASS = "flex-1 h-8 text-xs";

/** 参数类型下拉的触发项：与同一行的输入框同高同字号，宽度按最长选项（`file-list`）定死。 */
export const ENTRY_TYPE_SELECT_CLASS = "h-8 text-xs w-21";
