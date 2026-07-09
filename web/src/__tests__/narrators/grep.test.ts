import { describe, expect, test } from "bun:test";
import { grepNarrator } from "@/components/chat/narrators/grep";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * grepNarrator 单测。
 *
 * 覆盖：match 规则、verb、pattern 引号包裹（object）、
 * detail 由路径和结果数拼接（subtitle 行）、running 状态无 detail 计数部分。
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
    kind: "grep",
    status,
    t: mockT,
  };
}

describe("grepNarrator", () => {
  // kinds 包含 "grep"
  test("kinds 包含 grep", () => {
    expect(grepNarrator.kinds).toContain("grep");
  });

  // 中文动词必须是"搜索"
  test("verb 是 '搜索'", () => {
    expect(grepNarrator.verb).toBe("搜索");
  });

  // object 是带双引号的 pattern（与 verb 拼 title 时为"搜索 \"useEffect\""）
  test("object 是带引号的 pattern", () => {
    const { object } = grepNarrator.getDisplay(makeCtx({ pattern: "useEffect" }));
    expect(object).toBe('"useEffect"');
  });

  // 无 path 无 complete 计数时无 detail
  test("无 path 时无 detail（无结果数）", () => {
    const { detail } = grepNarrator.getDisplay(makeCtx({ pattern: "useEffect" }));
    expect(detail).toBeUndefined();
  });

  // 有 path 时 detail 包含路径
  test("有 path 时 detail 含路径", () => {
    const { detail } = grepNarrator.getDisplay(makeCtx({ pattern: "useEffect", path: "/src" }));
    expect(detail).toBe("在 /src");
  });

  // complete 状态从 count 字段提取结果数，detail 拼接路径和结果数
  test("complete 状态 detail 含路径和结果数", () => {
    const { detail } = grepNarrator.getDisplay(makeCtx({ pattern: "x", path: "/src" }, { count: 5 }));
    expect(detail).toBe("在 /src · 找到 5 个");
  });

  // 从 content 文本正则提取结果数（兼容不同 Agent 输出风格）
  test("complete 状态从 content 文本提取结果数", () => {
    const { detail } = grepNarrator.getDisplay(
      makeCtx({ pattern: "x" }, { content: [{ type: "text", text: "3 matches found" }] }),
    );
    expect(detail).toBe("找到 3 个");
  });

  // running 状态下 detail 不含结果数（结果还没出来），但仍可有路径
  test("running 状态 detail 只有路径无结果数", () => {
    const { detail } = grepNarrator.getDisplay(makeCtx({ pattern: "x", path: "/src" }, { count: 5 }, "running"));
    expect(detail).toBe("在 /src");
  });
});
