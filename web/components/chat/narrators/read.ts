import { FileText } from "lucide-react";
import { extractFileName, extractLineRange } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Read 工具 narrator。处理文件读取调用。
 *
 * 渲染效果（title 是 verb+object 完整句子，detail 是行号补充）：
 * - running: title="正在读 config.ts", detail="第 120-180 行"
 * - complete: title="读 config.ts", detail="第 120-180 行 · 1.2s"
 * - error: title="读 config.ts", detail="第 120-180 行"（错误细节单独一行）
 *
 * 行号区间作为 detail 显示在 subtitle 行（与耗时徽章并列），
 * title 只保留 verb + 文件名，避免上下文重复。
 */
export const readNarrator: ToolNarrator = {
  match: (name) => name.includes("read"),
  verb: "读",
  icon: FileText,
  getDisplay(ctx) {
    const file = extractFileName(ctx.tool.rawInput);
    const range = extractLineRange(ctx.tool.rawInput);
    // 行号区间作为 subtitle 的 detail，与耗时徽章并列显示
    const detail = range ? ctx.t("common.lineRange", { range }) : undefined;
    return { object: file, detail };
  },
};
