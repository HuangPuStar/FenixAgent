/**
 * Read 工具 narrator。处理文件 / 目录读取调用。
 * 复制自 `packages/agent-runtime/web/components/chat/narrators/read.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 *
 * 渲染效果（title 是 verb+object 完整句子，detail 是行号或条目数补充）：
 * - 文件读取：title="读取 config.ts", detail="第 120-180 行"
 * - 目录读取：title="读取 env_xxx", detail="2 个条目"
 * - running：title 前缀加"正在"
 *
 * 行号区间 / 条目数作为 detail 显示在 subtitle 行（与耗时徽章并列），
 * title 只保留 verb + 文件名，避免上下文重复。
 *
 * kinds 覆盖 read-file 和 read-directory 两种 ToolCardKind。
 *
 * 纯化改动点：i18n key 加 `chat.toolNarrator.` 前缀（原 key 路径不变）。
 */

import { FileText } from "lucide-react";
import { extractDirectoryEntryCount, extractFileName, extractLineRange, isOpencodeDirectoryOutput } from "./helpers";
import type { ToolNarrator } from "./types";

export const readNarrator: ToolNarrator = {
  kinds: ["read-file", "read-directory"],
  verb: "打开文件",
  icon: FileText,
  getDisplay(ctx) {
    // 优先使用 display 元数据获取文件名和路径信息
    const display = ctx.tool.display;
    const file = display?.path ? display.path.split("/").pop() || display.path : extractFileName(ctx.tool.rawInput);

    // 目录场景：detail 显示条目数，覆盖文件场景的行号区间
    if (ctx.kind === "read-directory" || isOpencodeDirectoryOutput(ctx.tool.rawOutput)) {
      const count = extractDirectoryEntryCount(ctx.tool.rawOutput);
      const detail = count ? ctx.t("chat.toolNarrator.read.entries", { count }) : undefined;
      return { object: file, verb: "查看目录", detail };
    }

    // 文件场景：行号区间作为 subtitle 的 detail，与耗时徽章并列显示
    // 优先使用 display.lineStart / display.lineEnd，兜底走 rawInput 提取
    if (display?.lineStart && display?.lineEnd) {
      const range = `${display.lineStart}-${display.lineEnd}`;
      const detail = ctx.t("chat.toolNarrator.common.lineRange", { range });
      return { object: file, detail };
    }
    const range = extractLineRange(ctx.tool.rawInput);
    const detail = range ? ctx.t("chat.toolNarrator.common.lineRange", { range }) : undefined;
    return { object: file, detail };
  },
};
