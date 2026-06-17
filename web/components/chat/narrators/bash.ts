import { Terminal } from "lucide-react";
import { truncate } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * Bash / Shell / Exec / Command 工具 narrator。
 *
 * title 加 $ 前缀（视觉上提示这是终端命令）；
 * object 不带前缀（副标题里已经有动词"跑"了，避免重复符号）。
 *
 * 注意：match 严格匹配 `name === "command"` 而非 includes，
 * 因为太多工具名可能包含 "command" 子串（如 "commandHandler"）。
 */
export const bashNarrator: ToolNarrator = {
  match: (name) => name.includes("bash") || name.includes("shell") || name.includes("exec") || name === "command",
  verb: "跑",
  icon: Terminal,
  getDisplay(ctx) {
    const cmd = String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.command ?? "");
    const truncated = truncate(cmd, 120);
    return {
      title: `$ ${truncated}`,
      object: truncated,
    };
  },
};
