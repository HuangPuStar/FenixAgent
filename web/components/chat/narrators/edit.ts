import { FilePen } from "lucide-react";
import { extractFileName } from "./helpers";
import type { NarrationBadge, ToolNarrator } from "./types";

/**
 * Edit / StrReplace / MultiEdit 工具 narrator。
 *
 * 从 content 数组中数 type === "diff" 的条目（每个对应一处编辑）。
 * complete 状态下显示"N 处"徽章，作为对编辑规模的直观反馈。
 *
 * 注意：徽章仅在 complete 状态显示，running 状态下 diff 还未生成。
 */
export const editNarrator: ToolNarrator = {
  match: (name) => name.includes("edit") || name.includes("str_replace") || name.includes("multiedit"),
  verb: "改",
  icon: FilePen,
  getDisplay(ctx) {
    const file = extractFileName(ctx.tool.rawInput);
    return { title: file, object: file };
  },
  badge(ctx): NarrationBadge | undefined {
    if (ctx.status !== "complete") return;
    const content = ctx.tool.content;
    if (!content || !Array.isArray(content)) return;
    // 统计 diff 类型的 content 条目
    const count = content.filter((c) => c && typeof c === "object" && (c as { type: string }).type === "diff").length;
    if (count === 0) return;
    return {
      tone: "success",
      text: ctx.t("toolNarrator.edit.changes", { count }),
    };
  },
};
