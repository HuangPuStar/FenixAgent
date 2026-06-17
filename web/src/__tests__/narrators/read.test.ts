import { describe, expect, test } from "bun:test";
import { readNarrator } from "@/components/chat/narrators/read";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * readNarrator 单测。
 *
 * 覆盖：match 规则、verb、文件名提取（object）、行号区间作为 detail、字段兼容。
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

  // 中文动词必须是"读取"
  test("verb 是 '读取'", () => {
    expect(readNarrator.verb).toBe("读取");
  });

  // 基本场景：从 file_path 提取文件名作为 object
  test("提取文件名（file_path）", () => {
    const { object, detail } = readNarrator.getDisplay(makeCtx({ file_path: "/a/b/c.ts" }));
    expect(object).toBe("c.ts");
    expect(detail).toBeUndefined();
  });

  // 有 offset+limit 时 object 仍是文件名，行号区间作为 detail
  test("offset+limit 转成行号区间作为 detail", () => {
    const { object, detail } = readNarrator.getDisplay(makeCtx({ file_path: "/a/b/c.ts", offset: 100, limit: 50 }));
    expect(object).toBe("c.ts");
    expect(detail).toBe("第 100-149 行");
  });

  // 无行号限制时 detail 不显示
  test("无 offset 时无 detail", () => {
    const { object, detail } = readNarrator.getDisplay(makeCtx({ file_path: "/x.ts" }));
    expect(object).toBe("x.ts");
    expect(detail).toBeUndefined();
  });

  // 兼容 path 字段（OpenCode 等其他 Agent 风格）
  test("兼容 path 字段", () => {
    const { object } = readNarrator.getDisplay(makeCtx({ path: "/y/z.ts" }));
    expect(object).toBe("z.ts");
  });
});
