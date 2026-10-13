/**
 * Edit / StrReplace / MultiEdit 工具 narrator。
 * 复制自 `packages/agent-runtime/web/components/chat/narrators/edit.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 *
 * 从 content 数组中数 type === "diff" 的条目（每个对应一处编辑）。
 * complete 状态下把"N 处变更"作为 detail 显示在 subtitle 行，
 * 直观反馈编辑规模。
 *
 * 注意：detail 仅在 complete 状态显示，running 状态下 diff 还未生成。
 *
 * 纯化改动点：i18n key 加 `chat.toolNarrator.` 前缀（原 key 路径不变）。
 */

import { FilePen } from "lucide-react";
import { extractFileName } from "./helpers";
import type { ToolNarrator } from "./types";

export const editNarrator: ToolNarrator = {
  kinds: ["edit"],
  verb: "修改文件",
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
          detail = ctx.t("chat.toolNarrator.edit.changes", { count });
        }
      }
    }
    return { object: file, detail };
  },
};
