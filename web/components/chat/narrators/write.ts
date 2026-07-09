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
  kinds: ["write"],
  verb: "写入",
  icon: FilePlus,
  getDisplay(ctx) {
    const display = ctx.tool.display;
    const file = display?.path ? display.path.split("/").pop() || display.path : extractFileName(ctx.tool.rawInput);
    return { object: file };
  },
};
