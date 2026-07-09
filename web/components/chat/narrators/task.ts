import { Workflow } from "lucide-react";
import { truncate } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Task / Agent / SubAgent 工具 narrator。处理子任务派发。
 *
 * 优先用 tool.description（Agent 提供的简短描述）作为展示文本，
 * 其次从 rawInput.description 取，最后兜底"子任务"中性词。
 */
export const taskNarrator: ToolNarrator = {
  kinds: ["task"],
  verb: "派发",
  icon: Workflow,
  getDisplay(ctx) {
    const rawDesc = String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.description ?? "");
    // tool.description 由 Agent 显式提供，比 rawInput.description 更可靠（结构化字段）
    const desc = ctx.tool.description ?? rawDesc ?? "子任务";
    const display = truncate(desc, 40);
    return { object: display };
  },
};
