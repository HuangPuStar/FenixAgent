import { FilePlus } from "lucide-react";
import { extractFileName } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Write 工具 narrator。处理文件创建/覆盖写入。
 *
 * 与 Edit 区分：Write 是整文件覆盖，Edit 是局部替换；
 * 视觉上用 FilePlus（新建/覆盖）vs FilePen（编辑）的图标差异体现。
 */
export const writeNarrator: ToolNarrator = {
  match: (name) => name.includes("write"),
  verb: "写",
  icon: FilePlus,
  getDisplay(ctx) {
    const file = extractFileName(ctx.tool.rawInput);
    return { object: file };
  },
};
