import { describe, expect, test } from "bun:test";
import { grepNarrator } from "@/components/chat/narrators/grep";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * grepNarrator 单测。
 *
 * 覆盖：match 规则、verb、pattern 引号包裹、路径后缀、
 * 从 rawOutput 提取结果数（两种结构变体）、running 状态无徽章。
 */

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "common.inPath") return `在 ${opts?.path}`;
  if (key === "toolNarrator.grep.results") return `找到 ${opts?.count} 个`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(
  rawInput: unknown,
  rawOutput?: unknown,
  status: NarrationContext["status"] = "complete",
): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Grep",
      status: status as ToolCallData["status"],
      rawInput: rawInput as Record<string, unknown>,
      rawOutput: rawOutput as Record<string, unknown> | undefined,
    } as ToolCallData,
    status,
    t: mockT,
  };
}

describe("grepNarrator", () => {
  // 匹配 grep / rg（ripgrep 别名）
  test("匹配 grep/rg", () => {
    expect(grepNarrator.match("grep")).toBe(true);
    expect(grepNarrator.match("rg")).toBe(true);
    expect(grepNarrator.match("read")).toBe(false);
  });

  // 中文动词必须是"搜"
  test("verb 是 '搜'", () => {
    expect(grepNarrator.verb).toBe("搜");
  });

  // title 是带双引号的 pattern
  test("title 是带引号的 pattern", () => {
    const { title } = grepNarrator.getDisplay(makeCtx({ pattern: "useEffect" }));
    expect(title).toBe('"useEffect"');
  });

  // 有 path 时 object 拼接路径后缀
  test("有 path 时 object 加路径后缀", () => {
    const { object } = grepNarrator.getDisplay(makeCtx({ pattern: "useEffect", path: "/src" }));
    expect(object).toBe('"useEffect" 在 /src');
  });

  // 无 path 时 object 与 title 一致
  test("无 path 时 object 只有 pattern", () => {
    const { object } = grepNarrator.getDisplay(makeCtx({ pattern: "useEffect" }));
    expect(object).toBe('"useEffect"');
  });

  // 从 rawOutput.count 提取结果数
  test("complete 状态从 count 字段提取结果数徽章", () => {
    const ctx = makeCtx({ pattern: "x" }, { count: 5 });
    expect(grepNarrator.badge?.(ctx)?.text).toBe("找到 5 个");
  });

  // 从 content 文本正则提取结果数（兼容不同 Agent 输出风格）
  test("complete 状态从 content 文本提取结果数", () => {
    const ctx = makeCtx({ pattern: "x" }, { content: [{ type: "text", text: "3 matches found" }] });
    expect(grepNarrator.badge?.(ctx)?.text).toBe("找到 3 个");
  });

  // running 状态下不应显示徽章（结果还没出来）
  test("running 状态无徽章", () => {
    const ctx = makeCtx({ pattern: "x" }, { count: 5 }, "running");
    expect(grepNarrator.badge?.(ctx)).toBeUndefined();
  });
});
