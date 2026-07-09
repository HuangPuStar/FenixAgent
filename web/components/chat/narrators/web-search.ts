import { Search } from "lucide-react";
import { truncate } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * WebSearch 工具 narrator。处理互联网搜索场景。
 *
 * title 行："搜索 \"query\""（运行中："正在搜索 ..."）
 * detail 行（subtitle）：complete 状态下显示结果数
 *
 * 与 webFetchNarrator 的 match 不冲突（search vs fetch），
 * 但保持"专用先于通用"的注册顺序约定，仍放在 webFetch 之后。
 */
export const webSearchNarrator: ToolNarrator = {
  kinds: ["web-search"],
  verb: "搜索",
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
        detail = ctx.t("toolNarrator.webSearch.results", { count: out.count });
      }
    }
    return { object: quoted, detail };
  },
};
