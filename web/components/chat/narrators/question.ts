import { HelpCircle } from "lucide-react";
import { truncate } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Question / Ask 工具 narrator。处理 Agent 向用户提问的场景。
 *
 * 主要状态是 waiting_for_confirmation（等用户回答）。
 * 优先用 tool.description（Agent 显式提供的完整问题），
 * 否则从 rawInput.question 兜底。
 */
export const questionNarrator: ToolNarrator = {
  match: (name) => name.includes("question") || name.includes("ask"),
  verb: "询问",
  icon: HelpCircle,
  getDisplay(ctx) {
    const text =
      ctx.tool.description ?? String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.question ?? "");
    // 加双引号强调问题文本本身
    const quoted = `"${truncate(text, 40)}"`;
    return { object: quoted };
  },
};
