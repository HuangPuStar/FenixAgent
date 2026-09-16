/**
 * Transform 节点 output key 改名时的表达式同步工具。
 *
 * 当用户修改 output 的 key 名时，自动更新对应表达式中的同名引用。
 * 规则：仅当旧 key 名作为词边界标识符出现在表达式中时才替换。
 */

/**
 * 转义正则特殊字符
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 同步单个 key 改名对应的表达式变更。
 *
 * @param output 当前的 output 映射
 * @param oldKey 旧 key 名
 * @param newKey 新 key 名
 * @returns 更新后的 output 映射
 */
export function syncExpressionOnKeyRename(
  output: Record<string, string>,
  oldKey: string,
  newKey: string,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, expr] of Object.entries(output)) {
    const newExprKey = key === oldKey ? newKey : key;
    // 替换表达式中所有作为词边界出现的旧 key 名（匹配 .field1, field1 >=, [field1] 等场景）
    const newExpr = expr.replace(new RegExp(`\\b${escapeRegex(oldKey)}\\b`, "g"), newKey);
    result[newExprKey] = newExpr;
  }

  return result;
}

/**
 * 检测 output 的 key 改名并自动同步所有受影响表达式。
 *
 * 改名检测策略：
 * - 找到旧 key 不在新 keys 中（removed）和新 key 不在旧 keys 中（added）
 * - 按顺序一一映射：第一个 removed → 第一个 added，以此类推
 * - 对每个映射调用 syncExpressionOnKeyRename
 *
 * @param oldOutput 改名前的 output
 * @param newOutput 改名后的 output（已包含改名后的 key）
 * @returns 同步表达式后的 output
 */
export function syncOutputOnRename(
  oldOutput: Record<string, string>,
  newOutput: Record<string, string>,
): Record<string, string> {
  const oldKeys = Object.keys(oldOutput);
  const newKeys = Object.keys(newOutput);

  // 找到被改名的 key：旧 key 不在新 output 中，且新 key 不在旧 output 中
  const removedKeys = oldKeys.filter((k) => !(k in newOutput));
  const addedKeys = newKeys.filter((k) => !(k in oldOutput));

  // 简单策略：假设 removed 和 added 按顺序一一对应
  let result = { ...newOutput };
  const renameCount = Math.min(removedKeys.length, addedKeys.length);
  for (let i = 0; i < renameCount; i++) {
    result = syncExpressionOnKeyRename(result, removedKeys[i], addedKeys[i]);
  }

  return result;
}
