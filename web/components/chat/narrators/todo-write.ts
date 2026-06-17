import { ListTodo } from "lucide-react";
import type { ToolNarrator } from "./types";

/**
 * TodoWrite 工具 narrator。处理待办列表更新场景。
 *
 * 兼容 todos 与 tasks 两种字段命名（不同 Agent 实现差异），
 * 用数组长度作为待办数渲染到 title 与 object。
 */
export const todoWriteNarrator: ToolNarrator = {
  match: (name) => name.includes("todo"),
  verb: "列",
  icon: ListTodo,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const list = raw?.todos ?? raw?.tasks;
    // 0 也展示，让卡片有内容（与 glob 空列表不显示徽章的策略不同，因为
    // todo 的"数量"本身就是核心信息）
    const count = Array.isArray(list) ? list.length : 0;
    const text = ctx.t("toolNarrator.todo.items", { count });
    return { title: text, object: text };
  },
};
