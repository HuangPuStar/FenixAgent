import { describe, expect, test } from "bun:test";
import type { NarrationContext } from "../chat/narrators/types";
import { writeNarrator } from "../chat/narrators/write";
import type { ToolCallData } from "../chat/types";

/**
 * writeNarrator 单测。
 *
 * 覆盖：match 规则、verb、文件名提取、字段兼容。
 *
 * 来源：`packages/agent-runtime/web/__tests__/write.test.ts` 逐字迁移，
 * 仅改写导入路径（narrator / 类型改指包内 `../chat/**`）。
 * narrator 实现为源文件逐字复制，该用例不涉及 i18n key，故断言与中文意图注释均保持不变。
 * 全程无 DOM / i18n 依赖（被测模块只 import 包内纯逻辑），因此不引入 happy-dom 引导。
 */

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Write",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    kind: "write",
    status: "complete",
    t: mockT,
  };
}

describe("writeNarrator", () => {
  // kinds 包含 "write"
  test("kinds 包含 write", () => {
    expect(writeNarrator.kinds).toContain("write");
  });

  // 中文动作必须明确表达文件写入行为
  test("verb 是 '写入文件'", () => {
    expect(writeNarrator.verb).toBe("写入文件");
  });

  // 从 file_path 提取文件名作为 object
  test("提取文件名", () => {
    const { object } = writeNarrator.getDisplay(makeCtx({ file_path: "/a/b/new.ts" }));
    expect(object).toBe("new.ts");
  });

  // 兼容 path 字段
  test("兼容 path 字段", () => {
    const { object } = writeNarrator.getDisplay(makeCtx({ path: "/x.ts" }));
    expect(object).toBe("x.ts");
  });
});
