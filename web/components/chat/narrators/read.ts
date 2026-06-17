import { FileText } from "lucide-react";
import {
  extractDirectoryEntryCount,
  extractFileName,
  extractLineRange,
  isOpencodeDirectoryOutput,
  isOpencodeFileOutput,
} from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Read 工具 narrator。处理文件 / 目录读取调用。
 *
 * 渲染效果（title 是 verb+object 完整句子，detail 是行号或条目数补充）：
 * - 文件读取：title="读取 config.ts", detail="第 120-180 行"
 * - 目录读取：title="读取 env_xxx", detail="2 个条目"
 * - running：title 前缀加"正在"
 *
 * 行号区间 / 条目数作为 detail 显示在 subtitle 行（与耗时徽章并列），
 * title 只保留 verb + 文件名，避免上下文重复。
 *
 * match 兜底：opencode 的 read 工具 title 是完整路径（不含 "read" 关键字），
 * 此时通过 rawInput.filePath/path + rawOutput 的 `<path>` / `<type>` 标签特征识别，
 * 避免落到 fallback 显示成"使用 env_xxx"。
 */
export const readNarrator: ToolNarrator = {
  match: (name, tool) => {
    // 标准匹配：title 含 "read"
    if (name.includes("read")) return true;

    // 兜底：opencode read 工具特征（中央 narrate() 会传 tool，单元测试可能省略）
    if (!tool) return false;

    // rawInput 必须有 filePath/path 字符串字段（与 extractFileName 兼容的命名）
    const input = tool.rawInput as Record<string, unknown> | undefined;
    const hasPathField =
      typeof input?.filePath === "string" || typeof input?.path === "string" || typeof input?.file_path === "string";
    if (!hasPathField) return false;

    // rawOutput 必须是 opencode 风格（<path> + <type>file|directory</type> 标签），
    // 这个组合在 edit/write/bash/grep/glob 等其他工具中不会出现，避免误伤
    return isOpencodeFileOutput(tool.rawOutput) || isOpencodeDirectoryOutput(tool.rawOutput);
  },
  verb: "读取",
  icon: FileText,
  getDisplay(ctx) {
    const file = extractFileName(ctx.tool.rawInput);

    // 目录场景：detail 显示条目数，覆盖文件场景的行号区间
    if (isOpencodeDirectoryOutput(ctx.tool.rawOutput)) {
      const count = extractDirectoryEntryCount(ctx.tool.rawOutput);
      const detail = count ? ctx.t("read.entries", { count }) : undefined;
      return { object: file, detail };
    }

    // 文件场景：行号区间作为 subtitle 的 detail，与耗时徽章并列显示
    const range = extractLineRange(ctx.tool.rawInput);
    const detail = range ? ctx.t("common.lineRange", { range }) : undefined;
    return { object: file, detail };
  },
};
