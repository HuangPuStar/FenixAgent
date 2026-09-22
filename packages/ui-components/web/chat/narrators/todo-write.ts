/**
 * TodoWrite 工具 narrator。处理待办列表更新场景。
 * 复制自 `packages/agent-runtime/web/components/chat/narrators/todo-write.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 *
 * 用本次相较上一轮的变更数渲染到 object，与 verb "更新" 拼成完整 title：
 *   [图标] 更新 2 项                    [完成]
 *
 * 历史工具卡片只展示变更条目，完整待办列表由输入框上方的状态面板（`ChatStatusPanel` 的
 * 待办 Tab）承载；首轮调用没有基线时，全部条目均视为新增。
 *
 * 纯化改动点：i18n key 加 `chat.toolNarrator.` 前缀（原 key 路径不变）。
 */

import { ListTodo } from "lucide-react";
import type { ToolNarrator } from "./types";

export const todoWriteNarrator: ToolNarrator = {
  kinds: ["todo"],
  verb: "更新待办",
  icon: ListTodo,
  getDisplay(ctx) {
    const changeCount = ctx.tool.todoChanges?.length;
    if (changeCount !== undefined) {
      return { object: ctx.t("chat.toolNarrator.todo.items", { count: changeCount }) };
    }

    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const list = raw?.todos ?? raw?.tasks;
    const count = Array.isArray(list) ? list.length : 0;
    return { object: ctx.t("chat.toolNarrator.todo.items", { count }) };
  },
};
