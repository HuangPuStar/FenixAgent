import { describe, expect, test } from "bun:test";
import { editNarrator } from "@/components/chat/narrators/edit";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * editNarrator 单测。
 *
 * 覆盖：match 规则（edit/str_replace/multiedit）、verb、文件名提取、
 * complete 状态的变更数徽章。
 */

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "toolNarrator.edit.changes") return `${opts?.count} 处`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, content?: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Edit",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
      content: content as ToolCallData["content"],
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("editNarrator", () => {
  // 匹配 Edit / StrReplace / MultiEdit 三种工具名
  test("匹配 edit/str_replace/multiedit", () => {
    expect(editNarrator.match("edit")).toBe(true);
    expect(editNarrator.match("str_replace")).toBe(true);
    expect(editNarrator.match("multiedit")).toBe(true);
    expect(editNarrator.match("read")).toBe(false);
  });

  // 中文动词必须是"改"
  test("verb 是 '改'", () => {
    expect(editNarrator.verb).toBe("改");
  });

  // 从 file_path 提取文件名
  test("提取文件名", () => {
    const { title } = editNarrator.getDisplay(makeCtx({ file_path: "/x/y.ts" }));
    expect(title).toBe("y.ts");
  });

  // complete 状态下从 content 数组数 diff 条目作为徽章
  test("complete 状态有变更数徽章（content 含 diff）", () => {
    const content = [
      { type: "diff", content: "..." },
      { type: "diff", content: "..." },
    ];
    const ctx = makeCtx({ file_path: "/x.ts" }, content);
    const badge = editNarrator.badge?.(ctx);
    expect(badge?.tone).toBe("success");
    expect(badge?.text).toBe("2 处");
  });

  // content 为空或无 diff 条目时不显示徽章
  test("无 diff 时无徽章", () => {
    const ctx = makeCtx({ file_path: "/x.ts" }, []);
    expect(editNarrator.badge?.(ctx)).toBeUndefined();
  });

  // 非 complete 状态（如 running）不显示徽章
  test("非 complete 状态无徽章", () => {
    const ctx = makeCtx({ file_path: "/x.ts" }, [{ type: "diff", content: "..." }]);
    ctx.status = "running";
    expect(editNarrator.badge?.(ctx)).toBeUndefined();
  });
});
