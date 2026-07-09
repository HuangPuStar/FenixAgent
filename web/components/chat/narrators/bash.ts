import { Terminal } from "lucide-react";
import { truncate } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Bash / Shell / Exec / Command 工具 narrator。
 *
 * object 加 $ 前缀（视觉上提示这是终端命令），与 verb "执行" 拼成 title：
 *   [图标] 执行 $ npm install            [完成]
 *          12.5s
 *
 * 注意：match 严格匹配 `name === "command"` 而非 includes，
 * 因为太多工具名可能包含 "command" 子串（如 "commandHandler"）。
 */
export const bashNarrator: ToolNarrator = {
  kinds: ["bash"],
  verb: "执行",
  icon: Terminal,
  getDisplay(ctx) {
    const cmd = String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.command ?? "");
    const display = `$ ${truncate(cmd, 120)}`;
    return { object: display };
  },
};
