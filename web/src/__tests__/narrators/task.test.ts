import { describe, expect, test } from "bun:test";
import { taskNarrator } from "@/components/chat/narrators/task";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * taskNarrator 单测。
 *
 * 覆盖：match 规则（task/agent/subagent/sub_agent）、verb、description 优先级、
 * rawInput.description 兜底、长文本截断。
 */

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, description?: string): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Task",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
      description,
    } as ToolCallData,
    kind: "task",
    status: "complete",
    t: mockT,
  };
}

describe("taskNarrator", () => {
  // kinds 包含 "task"
  test("kinds 包含 task", () => {
    expect(taskNarrator.kinds).toContain("task");
  });

  // 中文动词"派发"——传达"派发子任务"语义
  test("verb 是 '派发'", () => {
    expect(taskNarrator.verb).toBe("派发");
  });

  // 优先使用 tool.description（Agent 提供的简短描述）作为 object
  test("优先使用 description 字段", () => {
    const { object } = taskNarrator.getDisplay(makeCtx({}, "重构认证模块"));
    expect(object).toBe("重构认证模块");
  });

  // 无 tool.description 时从 rawInput.description 取
  test("无 description 时从 rawInput 取", () => {
    const { object } = taskNarrator.getDisplay(makeCtx({ description: "完成某个任务" }));
    expect(object).toBe("完成某个任务");
  });

  // description 过长截断到 40 字符（避免 title 行过长）
  test("description 过长截断到 40 字符", () => {
    const long = "x".repeat(50);
    const { object } = taskNarrator.getDisplay(makeCtx({}, long));
    expect((object as string).length).toBe(41); // 40 + 省略号
  });
});
