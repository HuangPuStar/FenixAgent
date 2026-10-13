import { describe, expect, test } from "bun:test";
import { todoWriteNarrator } from "../chat/narrators/todo-write";
import type { NarrationContext } from "../chat/narrators/types";
import type { ToolCallData } from "../chat/types";

/**
 * todoWriteNarrator 单测。
 *
 * 覆盖：kinds、verb、todos/tasks 字段兼容，以及有差分时只显示变更数量，
 * 防止工具卡片重新展示整份 TodoWrite 快照。
 *
 * 来源：`packages/agent-runtime/web/__tests__/todo-write.test.ts` 逐字迁移（用例名与中文注释保持不变），
 * 仅改写导入路径（narrator / 类型改指包内 `../chat/**`），并把 mockT 匹配的 i18n key
 * 加上纯化后的 `chat.toolNarrator.` 前缀（`todo.items` → `chat.toolNarrator.todo.items`）。
 */

// mockT：覆盖 todoWrite narrator 用到的 i18n key
// - chat.toolNarrator.todo.items：待办条目数（差分项数或快照数组长度）
const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "chat.toolNarrator.todo.items") return `${opts?.count} 项`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, todoChanges?: ToolCallData["todoChanges"]): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "TodoWrite",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
      todoChanges,
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

  // 中文动作必须明确表达待办更新行为
  test("verb 是 '更新待办'", () => {
    expect(todoWriteNarrator.verb).toBe("更新待办");
  });

  // 无历史差分时回退使用快照数组长度，兼容旧会话投影
  test("无差分时使用 todos 数组长度", () => {
    const { object } = todoWriteNarrator.getDisplay(makeCtx({ todos: [{}, {}, {}] }));
    expect(object).toBe("3 项");
  });

  // 兼容 tasks 字段，避免不同 Agent 的参数命名导致标题退化
  test("无差分时兼容 tasks 字段", () => {
    const { object } = todoWriteNarrator.getDisplay(makeCtx({ tasks: [{}, {}] }));
    expect(object).toBe("2 项");
  });

  // 连续调用的第二次只显示变更项数，不能使用完整快照中的 4 项
  test("有差分时只显示变更项数", () => {
    const { object, detail } = todoWriteNarrator.getDisplay(
      makeCtx({ todos: [{}, {}, {}, {}] }, [
        { id: "completed:实现增量展示::0", kind: "completed", todo: { content: "实现增量展示", status: "completed" } },
      ]),
    );

    expect(object).toBe("1 项");
    expect(detail).toBeUndefined();
  });

  // 无实际变更的调用保持显示 0 项，避免伪造进度信息
  test("空差分显示 0 项", () => {
    const { object } = todoWriteNarrator.getDisplay(makeCtx({ todos: [{}, {}] }, []));
    expect(object).toBe("0 项");
  });

  // 无待办字段时兜底显示 0
  test("无待办时兜底", () => {
    const { object } = todoWriteNarrator.getDisplay(makeCtx({}));
    expect(object).toBe("0 项");
  });
});
