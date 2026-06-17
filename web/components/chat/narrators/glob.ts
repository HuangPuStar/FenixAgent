import { FolderSearch } from "lucide-react";
import { truncate } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Glob / Find / ListFiles 工具 narrator。处理文件通配符匹配。
 *
 * title 行："找 {pattern}"（运行中："正在找 ..."）
 * detail 行（subtitle）：complete 状态下从 rawOutput.files 提取文件数
 *
 * 完整示例：
 *   [图标] 找 某个 pattern               [完成]
 *          15 个文件 · 0.3s
 */
export const globNarrator: ToolNarrator = {
  match: (name) =>
    name.includes("glob") || name.includes("find") || name.includes("listfiles") || name.includes("list_files"),
  verb: "找",
  icon: FolderSearch,
  getDisplay(ctx) {
    const pattern = String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.pattern ?? "");
    const display = truncate(pattern, 80);

    // complete 状态下提取文件数作为 detail（0 个文件无信息价值）
    let detail: string | undefined;
    if (ctx.status === "complete") {
      const raw = ctx.tool.rawOutput as Record<string, unknown> | undefined;
      const files = raw?.files;
      if (Array.isArray(files) && files.length > 0) {
        detail = ctx.t("toolNarrator.glob.files", { count: files.length });
      }
    }
    return { object: display, detail };
  },
};
