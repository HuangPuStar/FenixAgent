import { FileText } from "lucide-react";
import { extractFileName, extractLineRange } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Read 工具 narrator。处理文件读取调用。
 *
 * 副标题样例：
 * - running: "正在读 config.ts 第 120-180 行"
 * - complete: "读 config.ts 第 120-180 行"（+ 耗时徽章）
 * - error: "读 config.ts 第 120-180 行"（+ 错误细节在 title 下方）
 *
 * title 只显示文件名（保持卡片简洁），
 * object 额外拼接行号区间作为副标题里的位置信息。
 */
export const readNarrator: ToolNarrator = {
  match: (name) => name.includes("read"),
  verb: "读",
  icon: FileText,
  getDisplay(ctx) {
    const file = extractFileName(ctx.tool.rawInput);
    const range = extractLineRange(ctx.tool.rawInput);
    // 有行号限制时拼接"第 X-Y 行"后缀
    const object = range ? `${file} ${ctx.t("common.lineRange", { range })}` : file;
    return { title: file, object };
  },
};
