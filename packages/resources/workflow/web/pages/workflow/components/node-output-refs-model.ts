import type { Node } from "@xyflow/react";

/**
 * 输出字段的下游引用模型（纯函数，§3.5）。
 *
 * 输出字段改名或删除时，要先数清楚下游有多少处引用了 `nodes.<本节点 id>.output.<字段>` 形式的表达式，
 * 再决定是否弹确认框、以及确认后如何改写。这三件事（数、改名、置删除位）此前内联在 `NodeConfigCard`
 * 的事件回调里，与确认弹窗的 Promise 编排混在一起；拆开后「引用长什么样」只在本文件定义。
 *
 * 注意：改写函数里的正则**逐字保留**了拆分前的构造方式（含 `g` 标志一次构造、在 map 中 `test` 后再
 * `replace` 的次序），它决定了多节点场景下 `lastIndex` 的推进；这里不是可以顺手「修」的地方。
 */

/** 把节点 id / 输出字段名转义成可嵌入正则的字面量。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 数出下游节点 inputs 里引用了该输出字段的处数。 */
export function countOutputRefs(nodes: Node[], nodeId: string, key: string): number {
  let affectedCount = 0;
  const escapedId = escapeRegExp(nodeId);
  const refPattern = new RegExp(`nodes\\.${escapedId}\\.output\\.${escapeRegExp(key)}`);
  for (const node of nodes) {
    const inputs = node.data?.inputs as Record<string, string> | undefined;
    if (!inputs) continue;
    for (const val of Object.values(inputs)) {
      if (refPattern.test(val)) affectedCount++;
    }
  }
  return affectedCount;
}

/** 改名：把下游引用里的旧字段名换成新字段名，返回新的节点数组。 */
export function renameOutputRefs(nodes: Node[], nodeId: string, oldKey: string, newKey: string): Node[] {
  const escapedId = escapeRegExp(nodeId);
  const escapedOld = escapeRegExp(oldKey);
  const refPattern = new RegExp(`(nodes\\.${escapedId}\\.output\\.)${escapedOld}`, "g");
  return nodes.map((n) => {
    const inputs = n.data?.inputs as Record<string, string> | undefined;
    if (!inputs) return n;
    let changed = false;
    const updated: Record<string, string> = {};
    for (const [k, v] of Object.entries(inputs)) {
      if (refPattern.test(v)) {
        updated[k] = v.replace(refPattern, `$1${newKey}`);
        changed = true;
      } else {
        updated[k] = v;
      }
    }
    return changed ? { ...n, data: { ...n.data, inputs: updated } } : n;
  });
}

/** 删除：把下游引用里的字段名替换为 `<deleted>` 占位，返回新的节点数组。 */
export function clearOutputRefs(nodes: Node[], nodeId: string, key: string): Node[] {
  const escapedId = escapeRegExp(nodeId);
  const escapedKey = escapeRegExp(key);
  const refPattern = new RegExp(`(nodes\\.${escapedId}\\.output\\.)${escapedKey}`, "g");
  return nodes.map((n) => {
    const inputs = n.data?.inputs as Record<string, string> | undefined;
    if (!inputs) return n;
    let changed = false;
    const updated: Record<string, string> = {};
    for (const [k, v] of Object.entries(inputs)) {
      if (refPattern.test(v)) {
        updated[k] = v.replace(refPattern, "$1<deleted>");
        changed = true;
      } else {
        updated[k] = v;
      }
    }
    return changed ? { ...n, data: { ...n.data, inputs: updated } } : n;
  });
}
