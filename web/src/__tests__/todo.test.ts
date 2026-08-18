import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { structuredToThreadEntries } from "../lib/structured-to-thread";
import { getTodoChanges } from "../lib/todo";
import type { TodoItem } from "../lib/types";

describe("TodoWrite 增量投影", () => {
  // 状态变更、新增和移除必须被明确投影，未变化的条目不应重复展示。
  test("仅返回相较上一份快照的待办变更", () => {
    const previous: TodoItem[] = [
      { content: "分析需求", status: "in_progress", activeForm: "正在分析需求" },
      { content: "实现功能", status: "pending" },
      { content: "删除旧代码", status: "pending" },
    ];
    const current: TodoItem[] = [
      { content: "分析需求", status: "completed", activeForm: "正在分析需求" },
      { content: "实现功能", status: "in_progress", activeForm: "正在实现功能" },
      { content: "验证结果", status: "pending" },
    ];

    expect(getTodoChanges(previous, current)).toEqual([
      {
        id: "completed:分析需求:正在分析需求:0",
        kind: "completed",
        todo: { content: "分析需求", status: "completed", activeForm: "正在分析需求" },
      },
      {
        id: "in_progress:实现功能:正在实现功能:0",
        kind: "in_progress",
        todo: { content: "实现功能", status: "in_progress", activeForm: "正在实现功能" },
      },
      { id: "added:验证结果::0", kind: "added", todo: { content: "验证结果", status: "pending" } },
      { id: "removed:删除旧代码::0", kind: "removed", todo: { content: "删除旧代码", status: "pending" } },
    ]);
  });

  // 连续 TodoWrite 在时间线转换后，第二张工具卡片只能拿到本轮变化，不能重复完整清单。
  test("连续 TodoWrite 仅将当前调用的差分附加到工具卡片", () => {
    const messages: StructuredMessage[] = [
      {
        type: "tool_call",
        id: "todo-1",
        title: "TodoWrite",
        status: "complete",
        content: [],
        rawInput: {
          todos: [
            { content: "分析需求", status: "in_progress", activeForm: "正在分析需求" },
            { content: "实现功能", status: "pending" },
            { content: "验证结果", status: "pending" },
          ],
        },
      },
      {
        type: "tool_call",
        id: "todo-2",
        title: "TodoWrite",
        status: "complete",
        content: [],
        rawInput: {
          todos: [
            { content: "分析需求", status: "completed", activeForm: "正在分析需求" },
            { content: "实现功能", status: "in_progress", activeForm: "正在实现功能" },
            { content: "验证结果", status: "pending" },
          ],
        },
      },
    ];

    const entries = structuredToThreadEntries(messages);
    const first = entries[0];
    const second = entries[1];
    if (first?.type !== "tool_call" || second?.type !== "tool_call") throw new Error("expected tool call entries");

    expect(first.toolCall.todoChanges).toHaveLength(3);
    expect(second.toolCall.todoChanges).toEqual([
      {
        id: "completed:分析需求:正在分析需求:0",
        kind: "completed",
        todo: { content: "分析需求", status: "completed", activeForm: "正在分析需求" },
      },
      {
        id: "in_progress:实现功能:正在实现功能:0",
        kind: "in_progress",
        todo: { content: "实现功能", status: "in_progress", activeForm: "正在实现功能" },
      },
    ]);
  });
});
