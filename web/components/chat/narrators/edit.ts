import { FilePen } from "lucide-react";
import { extractFileName } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Edit / StrReplace / MultiEdit 工具 narrator。
 *
 * 从 content 数组中数 type === "diff" 的条目（每个对应一处编辑）。
 * complete 状态下把"N 处变更"作为 detail 显示在 subtitle 行，
 * 直观反馈编辑规模。
 *
 * 注意：detail 仅在 complete 状态显示，running 状态下 diff 还未生成。
 *
 * match 优先级：
 * 1. title 含 "edit" / "str_replace" / "multiedit"（标准匹配）
 * 2. display.type === "file" + rawInput 有编辑操作特征字段（opencode 兜底）
 * 3. display.type === "diff"（opencode 兜底）
 */
export const editNarrator: ToolNarrator = {
  match: (name, tool) => {
    if (name.includes("edit") || name.includes("str_replace") || name.includes("multiedit")) return true;
    // opencode 兜底：display.type 为 file 且 rawInput 有编辑字段，或 display.type 直接为 diff
    if (tool?.display?.type === "diff") return true;
    if (tool?.display?.type === "file") {
      const input = tool.rawInput as Record<string, unknown> | undefined;
      if (typeof input?.oldText === "string" || typeof input?.old_string === "string") return true;
    }
    return false;
  },
  verb: "修改",
  icon: FilePen,
  getDisplay(ctx) {
    const display = ctx.tool.display;
    const file = display?.path ? display.path.split("/").pop() || display.path : extractFileName(ctx.tool.rawInput);
    let detail: string | undefined;
    if (ctx.status === "complete") {
      const content = ctx.tool.content;
      if (Array.isArray(content)) {
        // 统计 diff 类型的 content 条目
        const count = content.filter(
          (c) => c && typeof c === "object" && (c as { type: string }).type === "diff",
        ).length;
        if (count > 0) {
          detail = ctx.t("toolNarrator.edit.changes", { count });
        }
      }
    }
    return { object: file, detail };
  },
};
