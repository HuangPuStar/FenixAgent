import { describe, expect, test } from "bun:test";
import { computeStats, formatTokenCount } from "../lib/token-stats";
import type { ThreadEntry } from "../lib/types";

// 小于 1000 的数字原样显示
describe("formatTokenCount", () => {
  test("formats numbers under 1000 as-is", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  // 大于等于 1000 的数字显示为 Nk（保留一位小数）
  test("formats numbers >= 1000 as Nk with one decimal", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(12300)).toBe("12.3k");
    expect(formatTokenCount(200000)).toBe("200.0k");
  });
});

describe("computeStats", () => {
  // 空数组返回全零
  test("returns zeros for empty entries", () => {
    const stats = computeStats([]);
    expect(stats.estimatedTokens).toBe(0);
    expect(stats.estimatedInputTokens).toBe(0);
    expect(stats.estimatedOutputTokens).toBe(0);
  });

  // user_message 的 content 计入 input tokens
  test("counts user_message content as input tokens", () => {
    const entries: ThreadEntry[] = [{ type: "user_message", id: "u1", content: "Hello world test" } as any];
    const stats = computeStats(entries);
    // "Hello world test" = 16 chars / 4 = 4 tokens
    expect(stats.estimatedInputTokens).toBe(4);
    expect(stats.estimatedTokens).toBe(4);
  });

  // assistant_message 的 chunks 文本计入 output tokens
  test("counts assistant_message chunks as output tokens", () => {
    const entries: ThreadEntry[] = [
      {
        type: "assistant_message",
        id: "a1",
        chunks: [
          { type: "message", text: "Hello" },
          { type: "message", text: " world" },
        ],
      } as any,
    ];
    const stats = computeStats(entries);
    // "Hello" + " world" = 12 chars / 4 = 3 tokens
    expect(stats.estimatedOutputTokens).toBe(3);
    expect(stats.estimatedTokens).toBe(3);
    expect(stats.estimatedInputTokens).toBe(0);
  });

  // tool_call 的 rawOutput 计入 output tokens
  test("counts tool_call rawOutput as output tokens", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "t1",
          title: "test",
          status: "complete",
          rawOutput: { result: "ok" },
        },
      } as any,
    ];
    const stats = computeStats(entries);
    // JSON.stringify({result:"ok"}) = '{"result":"ok"}' = 15 chars / 4 = 3.75 → 4 tokens
    expect(stats.estimatedOutputTokens).toBe(Math.round(JSON.stringify({ result: "ok" }).length / 4));
    expect(stats.estimatedTokens).toBe(stats.estimatedOutputTokens);
  });

  // 混合 entries 正确分类统计
  test("aggregates mixed entries correctly", () => {
    const entries: ThreadEntry[] = [
      { type: "user_message", id: "u1", content: "a".repeat(40) } as any,
      {
        type: "assistant_message",
        id: "a1",
        chunks: [{ type: "message", text: "b".repeat(80) }],
      } as any,
    ];
    const stats = computeStats(entries);
    // input: 40/4=10, output: 80/4=20, total: 120/4=30
    expect(stats.estimatedInputTokens).toBe(10);
    expect(stats.estimatedOutputTokens).toBe(20);
    expect(stats.estimatedTokens).toBe(30);
  });
});
