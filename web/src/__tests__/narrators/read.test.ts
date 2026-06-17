import { describe, expect, test } from "bun:test";
import { readNarrator } from "@/components/chat/narrators/read";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * readNarrator 单测。
 *
 * 覆盖：match 规则、verb、文件名提取、行号区间拼接、字段兼容。
 */

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "common.lineRange") return `第 ${opts?.range} 行`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Read",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("readNarrator", () => {
  // match 规则：包含 "read" 即命中（大小写不敏感）
  test("匹配包含 'read' 的工具名", () => {
    expect(readNarrator.match("read")).toBe(true);
    expect(readNarrator.match("fileread")).toBe(true);
    expect(readNarrator.match("write")).toBe(false);
  });

  // 中文动词必须是"读"
  test("verb 是 '读'", () => {
    expect(readNarrator.verb).toBe("读");
  });

  // 基本场景：从 file_path 提取文件名
  test("提取文件名（file_path）", () => {
    const { title, object } = readNarrator.getDisplay(makeCtx({ file_path: "/a/b/c.ts" }));
    expect(title).toBe("c.ts");
    expect(object).toBe("c.ts");
  });

  // 有 offset+limit 时 object 拼接行号区间
  test("offset+limit 转成行号区间", () => {
    const { title, object } = readNarrator.getDisplay(makeCtx({ file_path: "/a/b/c.ts", offset: 100, limit: 50 }));
    expect(title).toBe("c.ts");
    expect(object).toBe("c.ts 第 100-149 行");
  });

  // 无行号限制时 object 等于 title
  test("无 offset 时只显示文件名", () => {
    const { object } = readNarrator.getDisplay(makeCtx({ file_path: "/x.ts" }));
    expect(object).toBe("x.ts");
  });

  // 兼容 path 字段（OpenCode 等其他 Agent 风格）
  test("兼容 path 字段", () => {
    const { title } = readNarrator.getDisplay(makeCtx({ path: "/y/z.ts" }));
    expect(title).toBe("z.ts");
  });
});
