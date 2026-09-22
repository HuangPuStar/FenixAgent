/**
 * WebSearch 工具 narrator。处理互联网搜索场景。
 * 复制自 `packages/agent-runtime/web/components/chat/narrators/web-search.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 *
 * title 行："搜索 \"query\""（运行中："正在搜索 ..."）
 * detail 行（subtitle）：complete 状态下显示结果数
 *
 * 与 webFetchNarrator 的 match 不冲突（search vs fetch），
 * 但保持"专用先于通用"的注册顺序约定，仍放在 webFetch 之后。
 *
 * 纯化改动点：i18n key 加 `chat.toolNarrator.` 前缀（原 key 路径不变）。
 */

import { Search } from "lucide-react";
import { truncate } from "../lib/tool-call-utils";
import type { ToolNarrator } from "./types";

export const webSearchNarrator: ToolNarrator = {
  kinds: ["web-search"],
  verb: "搜索网页",
  icon: Search,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const query = String(raw?.query ?? raw?.search ?? "");
    // 加双引号强调搜索词文本本身（区别于 URL 抓取）
    const quoted = `"${truncate(query, 40)}"`;

    // complete 状态提取结果数作为 detail
    let detail: string | undefined;
    if (ctx.status === "complete") {
      const out = ctx.tool.rawOutput as Record<string, unknown> | undefined;
      if (typeof out?.count === "number") {
        detail = ctx.t("chat.toolNarrator.webSearch.results", { count: out.count });
      }
    }
    return { object: quoted, detail };
  },
};
