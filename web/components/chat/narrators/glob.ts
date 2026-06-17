import { FolderSearch } from "lucide-react";
import { truncate } from "./helpers";
import type { NarrationBadge, ToolNarrator } from "./types";

/**
 * Glob / Find / ListFiles 工具 narrator。处理文件通配符匹配。
 *
 * complete 状态下从 rawOutput.files 数组提取文件数，作为徽章
 * （优先于耗时徽章）。
 */
export const globNarrator: ToolNarrator = {
  match: (name) =>
    name.includes("glob") || name.includes("find") || name.includes("listfiles") || name.includes("list_files"),
  verb: "找",
  icon: FolderSearch,
  getDisplay(ctx) {
    const pattern = String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.pattern ?? "");
    const display = truncate(pattern, 80);
    return { title: display, object: display };
  },
  badge(ctx): NarrationBadge | undefined {
    if (ctx.status !== "complete") return;
    const raw = ctx.tool.rawOutput as Record<string, unknown> | undefined;
    const files = raw?.files;
    // 0 个文件无信息价值（不显示徽章），至少 1 个才显示
    if (!Array.isArray(files) || files.length === 0) return;
    return {
      tone: "success",
      text: ctx.t("toolNarrator.glob.files", { count: files.length }),
    };
  },
};
