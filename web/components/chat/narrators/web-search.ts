import { Search } from "lucide-react";
import { truncate } from "./helpers";
import type { NarrationBadge, ToolNarrator } from "./types";

/**
 * WebSearch 工具 narrator。处理互联网搜索场景。
 *
 * 与 webFetchNarrator 的 match 不冲突（search vs fetch），
 * 但保持"专用先于通用"的注册顺序约定，仍放在 webFetch 之后。
 */
export const webSearchNarrator: ToolNarrator = {
  match: (name) => name.includes("search"),
  verb: "搜",
  icon: Search,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const query = String(raw?.query ?? raw?.search ?? "");
    // 加双引号强调搜索词文本本身（区别于 URL 抓取）
    const quoted = `"${truncate(query, 40)}"`;
    return { title: quoted, object: quoted };
  },
  badge(ctx): NarrationBadge | undefined {
    if (ctx.status !== "complete") return;
    const raw = ctx.tool.rawOutput as Record<string, unknown> | undefined;
    if (typeof raw?.count === "number") {
      return {
        tone: "success",
        text: ctx.t("toolNarrator.webSearch.results", { count: raw.count }),
      };
    }
  },
};
