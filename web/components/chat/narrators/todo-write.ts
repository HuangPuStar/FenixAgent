import { ListTodo } from "lucide-react";
import type { ToolNarrator } from "./types";

/**
 * TodoWrite 工具 narrator。处理待办列表更新场景。
 *
 * 兼容 todos 与 tasks 两种字段命名（不同 Agent 实现差异），
 * 用数组长度作为待办数渲染到 object，与 verb "列出" 拼成完整 title：
 *   [图标] 列出 5 个待办                    [完成]
 *           已完成 3，进行中 2
 *
 * detail 行按 status 字段统计进度（completed / in_progress / pending），
 * 全部完成时仅显示完成数（如"全部 10/10 已完成"）。
 */
export const todoWriteNarrator: ToolNarrator = {
  kinds: ["todo"],
  verb: "列出",
  icon: ListTodo,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const list = (raw?.todos ?? raw?.tasks) as
      | Array<{ status?: string; content?: string; activeForm?: string }>
      | undefined;
    const count = Array.isArray(list) ? list.length : 0;
    const text = ctx.t("toolNarrator.todo.items", { count });

    // detail：按 status 统计进度
    if (Array.isArray(list) && list.length > 0) {
      const completed = list.filter((t) => t.status === "completed").length;
      const inProgress = list.filter((t) => t.status === "in_progress").length;

      if (completed === list.length) {
        const detail = ctx.t("toolNarrator.todo.allDone", { count });
        return { object: text, detail };
      }
      if (completed > 0 || inProgress > 0) {
        const detail = ctx.t("toolNarrator.todo.progress", { completed, inProgress });
        return { object: text, detail };
      }
    }

    return { object: text };
  },
};
