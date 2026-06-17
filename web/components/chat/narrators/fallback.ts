import { Wrench } from "lucide-react";
import { simplifyToolName } from "../tool-call-utils";
import { findFirstStringValue, truncate } from "./helpers";
import type { ToolNarrator } from "./types";

/**
 * 兜底 narrator。注册表最后位，match 永远返回 true。
 *
 * 用于未知工具或未在注册表中显式声明的工具。
 * "用"作为动词，比"调用"简洁、比"调"自然。
 *
 * 渲染示例：
 *   [图标] 用 UnknownTool                  [完成]
 *          some-param-value · 0.3s
 *
 * title 行是 verb + 工具名（人话描述），detail 行显示 rawInput
 * 里第一个字符串值作为附加上下文（如 MCP 工具的命令字串）。
 */
export const fallbackNarrator: ToolNarrator = {
  match: () => true,
  verb: "用",
  icon: Wrench,
  getDisplay(ctx) {
    // 复用 simplifyToolName（保留首字母大写等格式化逻辑）
    const name = simplifyToolName(ctx.tool.title);
    // 从 rawInput 找第一个字符串值作为 detail 补充信息
    const firstStr = findFirstStringValue(ctx.tool.rawInput);
    const detail = firstStr ? truncate(firstStr, 40) : undefined;
    return { object: name, detail };
  },
};
