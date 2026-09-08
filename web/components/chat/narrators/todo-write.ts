import { ListTodo } from "lucide-react";
import type { ToolNarrator } from "./types";

/**
 * TodoWrite 工具 narrator。处理待办列表更新场景。
 *
 * 用本次相较上一轮的变更数渲染到 object，与 verb "更新" 拼成完整 title：
 *   [图标] 更新 2 项                    [完成]
 *
 * 历史工具卡片只展示变更条目，完整待办列表由输入框上方的 TodoPanel 承载；首轮调用
 * 没有基线时，全部条目均视为新增。
 */
export const todoWriteNarrator: ToolNarrator = {
  kinds: ["todo"],
  verb: "更新待办",
  icon: ListTodo,
  getDisplay(ctx) {
    const changeCount = ctx.tool.todoChanges?.length;
    if (changeCount !== undefined) {
      return { object: ctx.t("todo.items", { count: changeCount }) };
    }

    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const list = raw?.todos ?? raw?.tasks;
    const count = Array.isArray(list) ? list.length : 0;
    return { object: ctx.t("todo.items", { count }) };
  },
};
