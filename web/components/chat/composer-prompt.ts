import type { ChatInputMessage } from "../../src/lib/types";

/**
 * 在发送边界将本轮选中的能力编码为 Agent 可见上下文。
 * UI 正文始终保持用户原始输入，避免 reminder 泄漏到 textarea 与历史草稿。
 */
export function buildPromptText(message: ChatInputMessage): string {
  const mcps = message.mcps ?? [];
  if (mcps.length === 0) return message.text;

  const lines = [
    "<system-reminder>",
    `The user selected these MCP connections for this turn: ${mcps.join(", ")}`,
    "Use the selected MCP connections when they are relevant to the user's request.",
    "</system-reminder>",
  ];
  return `${lines.join("\n")}\n\n${message.text}`;
}
