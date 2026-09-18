/**
 * WebFetch / Fetch / Curl 工具 narrator。处理 URL 抓取场景。
 * 复制自 `packages/agent-runtime/web/components/chat/narrators/web-fetch.ts`。
 *
 * match 用 includes("fetch") 而非 includes("webfetch")，因为某些 Agent 用 Fetch 简称；
 * WebSearch 用 includes("search")，与 fetch 不冲突，所以注册顺序无强约束。
 *
 * 纯化改动点：无（除类型导入路径）。
 */

import { Globe } from "lucide-react";
import { truncate } from "./helpers";
import type { ToolNarrator } from "./types";

export const webFetchNarrator: ToolNarrator = {
  kinds: ["web-fetch"],
  verb: "访问网页",
  icon: Globe,
  getDisplay(ctx) {
    const url = String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.url ?? "");
    const display = truncate(url, 80);
    return { object: display };
  },
};
