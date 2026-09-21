import { describe, expect, test } from "bun:test";
import { editNarrator } from "../chat/narrators/edit";
import type { NarrationContext } from "../chat/narrators/types";
import type { ToolCallData } from "../chat/types";

/**
 * editNarrator 单测。
 *
 * 覆盖：match 规则（edit/str_replace/multiedit）、verb、文件名提取、
 * complete 状态的变更数作为 detail。
 *
 * 来源：`packages/agent-runtime/web/__tests__/edit.test.ts` 逐字迁移，
 * 仅改写导入路径（narrator / 类型改指包内 `../chat/**`），并把 mock t 的
 * key 对齐包内命名空间（`edit.changes` → `chat.toolNarrator.edit.changes`）。
 */

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "chat.toolNarrator.edit.changes") return `${opts?.count} 处`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(
  rawInput: unknown,
  content?: unknown,
  status: NarrationContext["status"] = "complete",
): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Edit",
      status: status as ToolCallData["status"],
      rawInput: rawInput as Record<string, unknown>,
      content: content as ToolCallData["content"],
    } as ToolCallData,
    kind: "edit",
    status,
    t: mockT,
  };
}

describe("editNarrator", () => {
  // kinds 包含 "edit"
  test("kinds 包含 edit", () => {
    expect(editNarrator.kinds).toContain("edit");
  });

  // 中文动作必须明确表达文件修改行为
  test("verb 是 '修改文件'", () => {
    expect(editNarrator.verb).toBe("修改文件");
  });

  // 从 file_path 提取文件名作为 object
  test("提取文件名", () => {
    const { object, detail } = editNarrator.getDisplay(makeCtx({ file_path: "/x/y.ts" }));
    expect(object).toBe("y.ts");
    expect(detail).toBeUndefined();
  });

  // complete 状态下从 content 数组数 diff 条目作为 detail
  test("complete 状态有变更数 detail（content 含 diff）", () => {
    const content = [
      { type: "diff", content: "..." },
      { type: "diff", content: "..." },
    ];
    const { detail } = editNarrator.getDisplay(makeCtx({ file_path: "/x.ts" }, content));
    expect(detail).toBe("2 处");
  });

  // content 为空或无 diff 条目时不显示 detail
  test("无 diff 时无 detail", () => {
    const { detail } = editNarrator.getDisplay(makeCtx({ file_path: "/x.ts" }, []));
    expect(detail).toBeUndefined();
  });

  // 非 complete 状态（如 running）不显示 detail（diff 还未生成）
  test("非 complete 状态无 detail", () => {
    const { detail } = editNarrator.getDisplay(
      makeCtx({ file_path: "/x.ts" }, [{ type: "diff", content: "..." }], "running"),
    );
    expect(detail).toBeUndefined();
  });
});
