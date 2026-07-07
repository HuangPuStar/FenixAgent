import { FilePlus } from "lucide-react";
import { extractFileName } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Write 工具 narrator。处理文件创建/覆盖写入。
 *
 * 与 Edit 区分：Write 是整文件覆盖，Edit 是局部替换；
 * 视觉上用 FilePlus（新建/覆盖）vs FilePen（编辑）的图标差异体现。
 *
 * match 优先级：
 * 1. title 含 "write"（标准匹配）
 * 2. display.type === "file" + rawInput 有写操作特征字段（opencode 兜底）
 */
export const writeNarrator: ToolNarrator = {
  match: (name, tool) => {
    if (name.includes("write")) return true;
    // opencode 兜底：display.type 为 file 且 rawInput 有写操作字段
    if (tool?.display?.type === "file") {
      const input = tool.rawInput as Record<string, unknown> | undefined;
      if (typeof input?.newText === "string" || typeof input?.content === "string") return true;
    }
    return false;
  },
  verb: "写入",
  icon: FilePlus,
  getDisplay(ctx) {
    const display = ctx.tool.display;
    const file = display?.path ? display.path.split("/").pop() || display.path : extractFileName(ctx.tool.rawInput);
    return { object: file };
  },
};
