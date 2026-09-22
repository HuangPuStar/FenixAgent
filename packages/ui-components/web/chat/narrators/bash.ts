/**
 * Bash / Shell / Exec / Command 工具 narrator。
 * 复制自 `packages/agent-runtime/web/components/chat/narrators/bash.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 *
 * object 加 $ 前缀（视觉上提示这是终端命令），与 verb "执行" 拼成 title：
 *   [图标] 执行 $ npm install            [完成]
 *          12.5s
 *
 * 注意：match 严格匹配 `name === "command"` 而非 includes，
 * 因为太多工具名可能包含 "command" 子串（如 "commandHandler"）。
 *
 * 纯化改动点：无（除类型导入路径）。
 */

import { Terminal } from "lucide-react";
import { truncate } from "../lib/tool-call-utils";
import type { ToolNarrator } from "./types";

export const bashNarrator: ToolNarrator = {
  kinds: ["bash"],
  verb: "执行命令",
  icon: Terminal,
  getDisplay(ctx) {
    const cmd = String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.command ?? "");
    const display = `$ ${truncate(cmd, 120)}`;
    return { object: display };
  },
};
