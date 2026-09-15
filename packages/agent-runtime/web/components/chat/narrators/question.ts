import { HelpCircle } from "lucide-react";
import { truncate } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Question / Ask 工具 narrator。处理 Agent 向用户提问的场景。
 *
 * 主要状态是 waiting_for_confirmation（等用户回答）。
 * 优先用 tool.description（Agent 显式提供的完整问题），
 * 否则从 AskUserQuestion 协议输入 rawInput.questions[0].question 读取，
 * 并兼容单问题工具的 rawInput.question。
 */
export const questionNarrator: ToolNarrator = {
  kinds: ["question"],
  verb: "询问用户",
  icon: HelpCircle,
  getDisplay(ctx) {
    const rawInput = ctx.tool.rawInput;
    const firstQuestion = Array.isArray(rawInput?.questions) ? rawInput.questions[0] : undefined;
    const protocolQuestion =
      firstQuestion && typeof firstQuestion === "object" && "question" in firstQuestion
        ? firstQuestion.question
        : rawInput?.question;
    const text = ctx.tool.description ?? (typeof protocolQuestion === "string" ? protocolQuestion : "");
    // 加双引号强调问题文本本身
    const quoted = `"${truncate(text, 40)}"`;
    return { object: quoted };
  },
};
