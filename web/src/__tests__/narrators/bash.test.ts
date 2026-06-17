import { describe, expect, test } from "bun:test";
import { bashNarrator } from "@/components/chat/narrators/bash";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * bashNarrator 单测。
 *
 * 覆盖：match 规则、verb、object 的 $ 前缀、命令截断、字段缺失降级。
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

  // 中文动词必须是"执行"
  test("verb 是 '执行'", () => {
    expect(bashNarrator.verb).toBe("执行");
  });

  // object 加 $ 前缀作为终端命令的视觉提示（与 verb 拼 title 时为"执行 $ npm install"）
  test("object 加 $ 前缀", () => {
    const { object } = bashNarrator.getDisplay(makeCtx({ command: "npm install" }));
    expect(object).toBe("$ npm install");
  });

  // 超长命令截断到 120 字符 + 省略号（加 "$ " 前缀后总长 ≤ 123）
  test("长命令截断到 120 字符", () => {
    const longCmd = "x".repeat(200);
    const { object } = bashNarrator.getDisplay(makeCtx({ command: longCmd }));
    expect((object as string).length).toBeLessThanOrEqual(123); // "$ " + 120 + …
  });

  // 缺失 command 字段时降级为 "$ "
  test("无 command 字段时降级", () => {
    const { object } = bashNarrator.getDisplay(makeCtx({}));
    expect(object).toBe("$ ");
  });
});
