import { ListTodo } from "lucide-react";
import type { ToolNarrator } from "./types";

/**
 * TodoWrite 工具 narrator。处理待办列表更新场景。
 *
 * 兼容 todos 与 tasks 两种字段命名（不同 Agent 实现差异），
 * 用数组长度作为待办数渲染到 object，与 verb "列出" 拼成完整 title：
 *   [图标] 列出 5 个待办                    [完成]
 *
 * 待办数本身就是核心信息，所以即使 0 个也展示（与 glob 空列表不显示徽章策略不同）。
 */
export const todoWriteNarrator: ToolNarrator = {
  match: (name) => name.includes("todo"),
  verb: "列出",
  icon: ListTodo,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const list = raw?.todos ?? raw?.tasks;
    const count = Array.isArray(list) ? list.length : 0;
    const text = ctx.t("toolNarrator.todo.items", { count });
    return { object: text };
  },
};
