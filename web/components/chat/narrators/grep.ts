import { Search } from "lucide-react";
import { truncate } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Grep / Rg 工具 narrator。处理代码搜索。
 *
 * title 行："搜 \"pattern\""（运行中："正在搜 ..."）
 * detail 行（subtitle）：路径 + 命中数（complete 状态才有）
 *   - "在 src/ · 找到 8 个"
 *   - "找到 8 个"（无路径时）
 *
 * 完整示例：
 *   [图标] 搜 "useEffect"               [完成]
 *          在 src/ · 找到 8 个 · 0.5s
 */
export const grepNarrator: ToolNarrator = {
  match: (name) => name.includes("grep") || name.includes("rg"),
  verb: "搜",
  icon: Search,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const pattern = String(raw?.pattern ?? "");
    // 兼容 path 和 include 两种命名（部分 Agent 用 include 作为文件过滤）
    const path = String(raw?.path ?? raw?.include ?? "");
    const quoted = `"${truncate(pattern, 40)}"`;

    // detail 拼接：路径（如果有）+ 命中数（complete 状态可提取）
    const parts: string[] = [];
    if (path) {
      parts.push(ctx.t("common.inPath", { path: truncate(path, 30) }));
    }
    if (ctx.status === "complete") {
      const count = extractGrepResultCount(ctx.tool.rawOutput);
      if (count) {
        parts.push(ctx.t("toolNarrator.grep.results", { count }));
      }
    }
    const detail = parts.length > 0 ? parts.join(" · ") : undefined;
    return { object: quoted, detail };
  },
};

/**
 * 从 Grep 的 rawOutput 提取结果数量。
 *
 * 结构因 Agent 而异，常见模式：
 * - { count: N }：结构化字段
 * - { content: [{ type: "text", text: "N matches" }] }：自然语言文本，用正则提取
 *
 * 返回 undefined 表示无法提取。
 */
function extractGrepResultCount(rawOutput: unknown): number | undefined {
  if (!rawOutput || typeof rawOutput !== "object") return;
  const o = rawOutput as Record<string, unknown>;
  if (typeof o.count === "number") return o.count;
  if (Array.isArray(o.content)) {
    for (const c of o.content as Array<{ type: string; text?: unknown }>) {
      if (c.type === "text" && typeof c.text === "string") {
        // 兼容 "3 matches" / "5 results" / "10 hits" 三种写法
        const m = c.text.match(/(\d+)\s*(?:matches|results|hits)/i);
        if (m) return Number(m[1]);
      }
    }
  }
}
