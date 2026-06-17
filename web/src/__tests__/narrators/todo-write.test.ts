import { describe, expect, test } from "bun:test";
import { todoWriteNarrator } from "@/components/chat/narrators/todo-write";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * todoWriteNarrator 单测。
 *
 * 覆盖：match 规则（todowrite/todo_write/todo）、verb、todos/tasks 字段兼容、
 * 无字段兜底显示 0 个。
 */

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "toolNarrator.todo.items") return `${opts?.count} 个待办`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "TodoWrite",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("todoWriteNarrator", () => {
  // 匹配 todowrite / todo_write / todo 三种命名变体，read 不命中
  test("匹配 todo", () => {
    expect(todoWriteNarrator.match("todowrite")).toBe(true);
    expect(todoWriteNarrator.match("todo_write")).toBe(true);
    expect(todoWriteNarrator.match("todo")).toBe(true);
    expect(todoWriteNarrator.match("read")).toBe(false);
  });

  // 中文动词"列"——传达"列出待办"语义
  test("verb 是 '列'", () => {
    expect(todoWriteNarrator.verb).toBe("列");
  });

  // todos 数组长度作为待办数
  test("todos 数组长度作为待办数", () => {
    const { title } = todoWriteNarrator.getDisplay(makeCtx({ todos: [{}, {}, {}] }));
    expect(title).toBe("3 个待办");
  });

  // 兼容 tasks 字段（不同 Agent 命名差异）
  test("兼容 tasks 字段", () => {
    const { title } = todoWriteNarrator.getDisplay(makeCtx({ tasks: [{}, {}] }));
    expect(title).toBe("2 个待办");
  });

  // 无字段兜底显示 0 个待办（保持卡片有内容）
  test("无待办时兜底", () => {
    const { title } = todoWriteNarrator.getDisplay(makeCtx({}));
    expect(title).toBe("0 个待办");
  });
});
