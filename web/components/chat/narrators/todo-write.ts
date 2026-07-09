import { ListTodo } from "lucide-react";
import type { ToolNarrator } from "./types";

/**
 * TodoWrite 工具 narrator。处理待办列表更新场景。
 *
 * 用数组长度作为待办数渲染到 object，与 verb "更新" 拼成完整 title：
 *   [图标] 更新 5 个待办                    [完成]
 *          已完成 3 / 共 5
 *
 * detail 行按 status 统计完成进度，全部完成时显示"全部完成"。
 */
export const todoWriteNarrator: ToolNarrator = {
  kinds: ["todo"],
  verb: "更新",
  icon: ListTodo,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const list = (raw?.todos ?? raw?.tasks) as
      | Array<{ status?: string; content?: string; activeForm?: string }>
      | undefined;
    const count = Array.isArray(list) ? list.length : 0;
    const text = ctx.t("toolNarrator.todo.items", { count });

    if (Array.isArray(list) && list.length > 0) {
      const completed = list.filter((t) => t.status === "completed").length;

      if (completed === list.length) {
        return { object: text, detail: ctx.t("toolNarrator.todo.allDone") };
      }
      if (completed > 0) {
        return { object: text, detail: ctx.t("toolNarrator.todo.progress", { completed, count }) };
      }
    }

    return { object: text };
  },
};
