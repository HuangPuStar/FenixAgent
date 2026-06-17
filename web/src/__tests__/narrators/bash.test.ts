import { describe, expect, test } from "bun:test";
import { bashNarrator } from "@/components/chat/narrators/bash";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * bashNarrator 单测。
 *
 * 覆盖：match 规则、verb、title 的 $ 前缀、object 不带前缀、命令截断、字段缺失降级。
 */

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Bash",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("bashNarrator", () => {
  // 匹配 bash / shell / exec / 精确 "command"
  test("匹配 bash/shell/exec/command", () => {
    expect(bashNarrator.match("bash")).toBe(true);
    expect(bashNarrator.match("shell")).toBe(true);
    expect(bashNarrator.match("exec")).toBe(true);
    expect(bashNarrator.match("command")).toBe(true);
    expect(bashNarrator.match("read")).toBe(false);
  });

  // 中文动词必须是"跑"
  test("verb 是 '跑'", () => {
    expect(bashNarrator.verb).toBe("跑");
  });

  // title 加 $ 前缀作为终端命令的视觉提示
  test("title 加 $ 前缀", () => {
    const { title } = bashNarrator.getDisplay(makeCtx({ command: "npm install" }));
    expect(title).toBe("$ npm install");
  });

  // object 不带 $ 前缀（副标题里已经有动词"跑"）
  test("object 不带 $ 前缀", () => {
    const { object } = bashNarrator.getDisplay(makeCtx({ command: "npm install" }));
    expect(object).toBe("npm install");
  });

  // 超长命令截断到 120 字符 + 省略号
  test("长命令截断到 120 字符", () => {
    const longCmd = "x".repeat(200);
    const { title, object } = bashNarrator.getDisplay(makeCtx({ command: longCmd }));
    expect((title as string).length).toBeLessThanOrEqual(123); // "$ " + 120 + …
    expect((object as string).length).toBeLessThanOrEqual(121);
  });

  // 缺失 command 字段时降级为空字符串
  test("无 command 字段时降级", () => {
    const { title, object } = bashNarrator.getDisplay(makeCtx({}));
    expect(title).toBe("$ ");
    expect(object).toBe("");
  });
});
