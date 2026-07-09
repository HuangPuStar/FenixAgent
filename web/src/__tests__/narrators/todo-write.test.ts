import { describe, expect, test } from "bun:test";
import { todoWriteNarrator } from "@/components/chat/narrators/todo-write";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * todoWriteNarrator 单测。
 *
 * 覆盖：kinds、verb、todos/tasks 字段兼容、完成进度 detail、
 * 全部完成特殊文案、仅有 pending 时不显示 detail。
 */

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "toolNarrator.todo.items") return `${opts?.count} 项`;
  if (key === "toolNarrator.todo.progress") return `已完成 ${opts?.completed} / 共 ${opts?.count}`;
  if (key === "toolNarrator.todo.allDone") return "全部完成";
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
    kind: "todo",
    status: "complete",
    t: mockT,
  };
}

describe("todoWriteNarrator", () => {
  // kinds 包含 "todo"
  test("kinds 包含 todo", () => {
    expect(todoWriteNarrator.kinds).toContain("todo");
  });

  // 中文动词"更新"—传达"更新待办列表"语义
  test("verb 是 '更新'", () => {
    expect(todoWriteNarrator.verb).toBe("更新");
  });

  // todos 数组长度作为待办数渲染到 object
  test("todos 数组长度作为待办数", () => {
    const { object } = todoWriteNarrator.getDisplay(makeCtx({ todos: [{}, {}, {}] }));
    expect(object).toBe("3 项");
  });

  // 兼容 tasks 字段
  test("兼容 tasks 字段", () => {
    const { object } = todoWriteNarrator.getDisplay(makeCtx({ tasks: [{}, {}] }));
    expect(object).toBe("2 项");
  });

  // 无字段兜底显示 0
  test("无待办时兜底", () => {
    const { object } = todoWriteNarrator.getDisplay(makeCtx({}));
    expect(object).toBe("0 项");
  });

  // detail：有已完成 + 未完成 → 显示进度
  test("detail 显示完成进度", () => {
    const todos = [
      { status: "completed", content: "a" },
      { status: "completed", content: "b" },
      { status: "in_progress", content: "c" },
      { status: "pending", content: "d" },
    ];
    const { object, detail } = todoWriteNarrator.getDisplay(makeCtx({ todos }));
    expect(object).toBe("4 项");
    expect(detail).toBe("已完成 2 / 共 4");
  });

  // 全部完成时显示"全部完成"
  test("全部完成时显示 allDone", () => {
    const todos = [
      { status: "completed", content: "a" },
      { status: "completed", content: "b" },
    ];
    const { object, detail } = todoWriteNarrator.getDisplay(makeCtx({ todos }));
    expect(object).toBe("2 项");
    expect(detail).toBe("全部完成");
  });

  // 仅有 pending 时不显示 detail
  test("仅有 pending 时无 detail", () => {
    const todos = [{ status: "pending", content: "a" }];
    const { object, detail } = todoWriteNarrator.getDisplay(makeCtx({ todos }));
    expect(object).toBe("1 项");
    expect(detail).toBeUndefined();
  });

  // 全部 pending 但无任何完成 → 无 detail
  test("全部 pending 无 detail", () => {
    const todos = [
      { status: "pending", content: "a" },
      { status: "pending", content: "b" },
    ];
    const { object, detail } = todoWriteNarrator.getDisplay(makeCtx({ todos }));
    expect(object).toBe("2 项");
    expect(detail).toBeUndefined();
  });

  // 空数组无 detail
  test("空数组无 detail", () => {
    const { object, detail } = todoWriteNarrator.getDisplay(makeCtx({ todos: [] }));
    expect(object).toBe("0 项");
    expect(detail).toBeUndefined();
  });
});
