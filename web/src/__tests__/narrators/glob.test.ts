import { describe, expect, test } from "bun:test";
import { globNarrator } from "@/components/chat/narrators/glob";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * globNarrator 单测。
 *
 * 覆盖：match 规则（glob/find/listfiles/list_files）、verb、pattern 作为 object、
 * complete 状态从 rawOutput.files 提取文件数作为 detail。
 */

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "toolNarrator.glob.files") return `${opts?.count} 个文件`;
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
      title: "Glob",
      status: status as ToolCallData["status"],
      rawInput: rawInput as Record<string, unknown>,
      rawOutput: rawOutput as Record<string, unknown> | undefined,
    } as ToolCallData,
    status,
    t: mockT,
  };
}

describe("globNarrator", () => {
  // 匹配 glob / find / listfiles / list_files 四种命名变体
  test("匹配 glob/find/listfiles", () => {
    expect(globNarrator.match("glob")).toBe(true);
    expect(globNarrator.match("find")).toBe(true);
    expect(globNarrator.match("listfiles")).toBe(true);
    expect(globNarrator.match("list_files")).toBe(true);
  });

  // 中文动词必须是"查找"（区别于 Grep 的"搜索"）
  test("verb 是 '查找'", () => {
    expect(globNarrator.verb).toBe("查找");
  });

  // pattern 作为 object（与 verb 拼 title 时为"查找 {pattern}"）
  test("object 是 pattern", () => {
    const { object, detail } = globNarrator.getDisplay(makeCtx({ pattern: "**/*.ts" }));
    expect(object).toBe("**/*.ts");
    expect(detail).toBeUndefined();
  });

  // complete 状态下从 rawOutput.files 数组长度提取文件数作为 detail
  test("complete 状态有文件数 detail", () => {
    const { detail } = globNarrator.getDisplay(makeCtx({ pattern: "**/*.ts" }, { files: ["a.ts", "b.ts"] }));
    expect(detail).toBe("2 个文件");
  });

  // 空文件列表不显示 detail（0 个文件无信息价值）
  test("无文件时无 detail", () => {
    const { detail } = globNarrator.getDisplay(makeCtx({ pattern: "**/*.ts" }, { files: [] }));
    expect(detail).toBeUndefined();
  });
});
