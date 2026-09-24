import type { CustomToolInputDef, CustomToolItem } from "../../../api/workflow-defs";
import type { OutputEntry, OutputType } from "./OutputsEditor";

/**
 * 节点配置卡片的纯模型层（§3.5）：三个只由入参决定的函数，不认识 React，也不发请求。
 *
 * - `groupInputDefs` / `resolveToolOutputs` 只服务 custom 工具节点（工具声明的字段与产出）；
 * - `getDisplayOutputs` 是其余带 outputs 的节点的共同兜底口径（无声明就预填 stdout）。
 * 放在一处是因为它们回答的是同一个问题——「这个节点该显示哪些字段、字段初值是什么」。
 */

/** 按 tool InputDef 的 group 分组，返回 { group, keys, collapsed }[]。
 *  未声明 group 的字段归入默认组（""）。advance 组排在最后。 */
export function groupInputDefs(
  toolInputs: Record<string, CustomToolInputDef>,
): Array<{ group: string; keys: string[]; collapsed: boolean }> {
  const groups: Record<string, string[]> = {};
  const order: string[] = [];

  for (const [key, def] of Object.entries(toolInputs)) {
    const g = def.group ?? "";
    if (!groups[g]) {
      groups[g] = [];
      order.push(g);
    }
    groups[g].push(key);
  }

  // advance 组排到最后
  const advanceIdx = order.indexOf("advance");
  if (advanceIdx > -1) {
    order.splice(advanceIdx, 1);
    order.push("advance");
  }

  return order.map((g) => ({
    group: g,
    keys: groups[g],
    collapsed: g === "advance",
  }));
}

/** 获取输出的显示值，若无声明则自动预填 stdout 作为默认输出 */
export function getDisplayOutputs(existing: Record<string, OutputEntry> | undefined): Record<string, OutputEntry> {
  if (existing && Object.keys(existing).length > 0) return existing;
  return { stdout: { pattern: "", type: "value" } };
}

/**
 * custom 工具节点的 outputs 显示值：工具声明的 produces 不是通配符时按声明预填，否则兜底 stdout。
 * 已有 entry 但 pattern 为空且类型是 file 的，升为 value（通配符工具的历史数据就是这种形态）。
 */
export function resolveToolOutputs(
  existing: Record<string, OutputEntry> | undefined,
  tool: CustomToolItem | undefined,
): Record<string, OutputEntry> {
  if (existing && Object.keys(existing).length > 0) return existing;
  if (!tool) return { stdout: { pattern: "", type: "value" as OutputType } };
  if (tool.produces.includes("*") || tool.produces.length === 0) {
    return { stdout: { pattern: "", type: "value" as OutputType } };
  }
  const defaults: Record<string, OutputEntry> = {};
  for (const key of tool.produces) {
    const entry = existing?.[key] as OutputEntry | undefined;
    // 已有 entry 但 pattern 为空且类型为 file → 升为 value
    const normalized =
      entry?.pattern === "" && entry?.type === "file" ? { ...entry, type: "value" as OutputType } : entry;
    defaults[key] = normalized ?? { pattern: "", type: "value" as OutputType };
  }
  return defaults;
}
