import { Sparkles } from "lucide-react";
import type { ToolNarrator } from "./types";

/**
 * Loaded Skill 工具 narrator。处理技能加载通知。
 *
 * 现有 ACP 协议下 title 格式为 "Loaded Skill: <name>"。
 * 优先用 tool.description（Agent 提供的技能描述，更可读），
 * 否则从 title 提取冒号后的 skill 名。
 */
export const skillNarrator: ToolNarrator = {
  match: (name) => name.includes("skill"),
  verb: "加载",
  icon: Sparkles,
  getDisplay(ctx) {
    // 优先 description（结构化字段，Agent 显式提供）
    if (ctx.tool.description) {
      return { object: ctx.tool.description };
    }
    // 从 "Loaded Skill: xxx" 提取 xxx 部分
    const match = ctx.tool.title.match(/skill:\s*(.+)/i);
    const name = match ? match[1].trim() : ctx.tool.title;
    return { object: name };
  },
};
