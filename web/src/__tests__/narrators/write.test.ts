import { describe, expect, test } from "bun:test";
import type { NarrationContext } from "@/components/chat/narrators/types";
import { writeNarrator } from "@/components/chat/narrators/write";
import type { ToolCallData } from "@/src/lib/types";

/**
 * writeNarrator 单测。
 *
 * 覆盖：match 规则、verb、文件名提取、字段兼容。
 */

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Write",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("writeNarrator", () => {
  // 匹配包含 "write" 的工具名
  test("匹配 write", () => {
    expect(writeNarrator.match("write")).toBe(true);
    expect(writeNarrator.match("file_write")).toBe(true);
    expect(writeNarrator.match("read")).toBe(false);
  });

  // 中文动词必须是"写"
  test("verb 是 '写'", () => {
    expect(writeNarrator.verb).toBe("写");
  });

  // 从 file_path 提取文件名作为 object
  test("提取文件名", () => {
    const { object } = writeNarrator.getDisplay(makeCtx({ file_path: "/a/b/new.ts" }));
    expect(object).toBe("new.ts");
  });

  // 兼容 path 字段
  test("兼容 path 字段", () => {
    const { object } = writeNarrator.getDisplay(makeCtx({ path: "/x.ts" }));
    expect(object).toBe("x.ts");
  });
});
