/**
 * Write 工具 narrator。处理文件创建/覆盖写入。
 * 复制自 `packages/agent-runtime/web/components/chat/narrators/write.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 *
 * 与 Edit 区分：Write 是整文件覆盖，Edit 是局部替换；
 * 视觉上用 FilePlus（新建/覆盖）vs FilePen（编辑）的图标差异体现。
 *
 * 纯化改动点：无（除类型导入路径）。
 */

import { FilePlus } from "lucide-react";
import { extractFileName } from "./helpers";
import type { ToolNarrator } from "./types";

export const writeNarrator: ToolNarrator = {
  kinds: ["write"],
  verb: "写入文件",
  icon: FilePlus,
  getDisplay(ctx) {
    const display = ctx.tool.display;
    const file = display?.path ? display.path.split("/").pop() || display.path : extractFileName(ctx.tool.rawInput);
    return { object: file };
  },
};
