import type { ThreadEntry, ToolCallEntry } from "./types";

/** Token 用量估算结果，按 input/output 拆分 */
export interface TokenStats {
  estimatedTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

/**
 * 从对话 entries 估算 token 用量。
 *
 * 估算规则：
 * - `user_message` 的 content 计入 input tokens
 * - `assistant_message` 的 chunks 文本计入 output tokens
 * - `tool_call` 的 rawOutput（JSON 序列化后）计入 output tokens
 *
 * 估算方式为 字符数 / 4（粗略近似，与 StatusHeader 原始实现保持一致）。
 *
 * @param entries 对话线程条目列表
 * @returns 按 input/output 拆分的 token 估算
 */
export function computeStats(entries: ThreadEntry[]): TokenStats {
  let totalChars = 0;
  let inputChars = 0;
  let outputChars = 0;

  for (const entry of entries) {
    // 助手消息：chunks 文本计入 output
    if (entry.type === "assistant_message") {
      const text = entry.chunks.reduce((sum, c) => sum + (c.text?.length || 0), 0);
      outputChars += text;
      totalChars += text;
    }
    // 用户消息：content 计入 input
    if (entry.type === "user_message") {
      const text = entry.content?.length || 0;
      inputChars += text;
      totalChars += text;
    }
    // 工具调用：rawOutput JSON 序列化后计入 output
    if (entry.type === "tool_call") {
      const rawOutput = (entry as ToolCallEntry).toolCall.rawOutput;
      if (rawOutput) {
        const text = JSON.stringify(rawOutput).length;
        outputChars += text;
        totalChars += text;
      }
    }
  }

  return {
    estimatedTokens: Math.round(totalChars / 4),
    estimatedInputTokens: Math.round(inputChars / 4),
    estimatedOutputTokens: Math.round(outputChars / 4),
  };
}

/**
 * 格式化 token 数为人类可读字符串。
 *
 * - 小于 1000：显示原值（如 `"999"`）
 * - 大于等于 1000：显示为 `Nk` 并保留一位小数（如 `"12.3k"`）
 *
 * @param n token 数量
 * @returns 格式化后的字符串
 */
export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
