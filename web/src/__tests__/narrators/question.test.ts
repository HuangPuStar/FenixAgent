import { describe, expect, test } from "bun:test";
import { questionNarrator } from "@/components/chat/narrators/question";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * questionNarrator 单测。
 *
 * 覆盖：match 规则（question/ask）、verb、description/rawInput.question 优先级、
 * 长问题截断（带双引号包裹后的总长度）。
 */

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, description?: string): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Question",
      status: "waiting_for_confirmation",
      rawInput: rawInput as Record<string, unknown>,
      description,
    } as ToolCallData,
    status: "waiting_for_confirmation",
    t: mockT,
  };
}

describe("questionNarrator", () => {
  // 匹配 question / ask 两种命名变体，read 不命中
  test("匹配 question/ask", () => {
    expect(questionNarrator.match("question")).toBe(true);
    expect(questionNarrator.match("ask")).toBe(true);
    expect(questionNarrator.match("read")).toBe(false);
  });

  // 中文动词"问"——传达"向用户提问"语义
  test("verb 是 '问'", () => {
    expect(questionNarrator.verb).toBe("问");
  });

  // 优先用 description（Agent 提供的完整问题）作为 object
  test("从 description 提取问题文本", () => {
    const { object } = questionNarrator.getDisplay(makeCtx({}, "要不要继续？"));
    expect(object).toBe('"要不要继续？"');
  });

  // 无 description 时从 rawInput.question 取
  test("从 rawInput.question 提取", () => {
    const { object } = questionNarrator.getDisplay(makeCtx({ question: "用什么方案？" }));
    expect(object).toBe('"用什么方案？"');
  });

  // 长问题截断：truncate(40) = 41 字符 + 前后双引号 = 43 字符
  test("长问题截断到 40 字符", () => {
    const long = "x".repeat(50);
    const { object } = questionNarrator.getDisplay(makeCtx({}, long));
    expect((object as string).length).toBe(43); // 40 + 省略号 + 前后双引号
  });
});
