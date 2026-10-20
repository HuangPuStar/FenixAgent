import { describe, expect, test } from "bun:test";
import { buildToolDetail } from "../chat/timeline/tool-detail-model";
import type { ToolCallData } from "../chat/types";

/**
 * 工具行行内详情投影的纯函数测试。
 *
 * 数据来源按优先级：ACP diff 块 > 内容文本块 > rawOutput 文本字段 > display.text；
 * 拿不到可读文本时必须返回 null，避免渲染空展开区。
 */

function tool(overrides: Partial<ToolCallData> = {}): ToolCallData {
  return { id: "tool-1", title: "Edit", status: "complete", kind: "edit", ...overrides };
}

describe("工具行行内详情", () => {
  // 同一调用同时带 diff 与文本时，diff 是用户最关心的变更内容。
  test("diff 块优先于内容文本", () => {
    const detail = buildToolDetail(
      tool({
        content: [
          { type: "content", content: { type: "text", text: "applied" } },
          { type: "diff", path: "src/app.ts", oldText: "const a = 1;", newText: "const a = 2;" },
        ],
      }),
    );

    expect(detail).toEqual({
      type: "diff",
      files: [{ path: "src/app.ts", oldText: "const a = 1;", newText: "const a = 2;" }],
    });
  });

  // 新增文件的 diff 没有旧文本，必须保留为 null 而不是空串，供 diff 计算按新增处理。
  test("新增文件 diff 保留 null 旧文本", () => {
    const detail = buildToolDetail(
      tool({ content: [{ type: "diff", path: "src/new.ts", newText: "export const a = 1;" }] }),
    );

    expect(detail).toEqual({
      type: "diff",
      files: [{ path: "src/new.ts", oldText: null, newText: "export const a = 1;" }],
    });
  });

  // 内容文本块是读取/搜索类工具的主要输出来源。
  test("内容文本块作为输出文本", () => {
    const detail = buildToolDetail(
      tool({ content: [{ type: "content", content: { type: "text", text: "first\nsecond" } }] }),
    );

    expect(detail).toEqual({
      type: "text",
      text: "first\nsecond",
      path: undefined,
      lineStart: undefined,
      lineEnd: undefined,
      truncated: false,
    });
  });

  // 终端工具的输出通常只在 rawOutput.output，必须能直接展开。
  test("读取 rawOutput 的终端输出", () => {
    const detail = buildToolDetail(tool({ kind: "bash", rawOutput: { output: "hello world" } }));

    expect(detail?.type).toBe("text");
    if (detail?.type !== "text") throw new Error("expected text detail");
    expect(detail.text).toBe("hello world");
  });

  // 读取类工具的 rawOutput.content 常是文本块数组，必须展开为多行文本。
  test("展开 rawOutput.content 文本块数组", () => {
    const detail = buildToolDetail(
      tool({
        kind: "read-file",
        rawOutput: {
          content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
        },
      }),
    );

    if (detail?.type !== "text") throw new Error("expected text detail");
    expect(detail.text).toBe("line 1\nline 2");
  });

  // Glob 一类工具只返回文件列表，展开后逐行展示。
  test("展开文件列表", () => {
    const detail = buildToolDetail(tool({ kind: "glob", rawOutput: { files: ["a.ts", "b.ts"] } }));

    if (detail?.type !== "text") throw new Error("expected text detail");
    expect(detail.text).toBe("a.ts\nb.ts");
  });

  // stdout 与 stderr 分开返回时合并展示，避免只看到一半输出。
  test("合并 stdout 与 stderr", () => {
    const detail = buildToolDetail(tool({ kind: "bash", rawOutput: { stdout: "out", stderr: "err" } }));

    if (detail?.type !== "text") throw new Error("expected text detail");
    expect(detail.text).toBe("out\nerr");
  });

  // 引擎提供的 display 片段与路径/行号是最后兜底，仍需带上定位信息。
  test("回落到 display 文本并保留路径与行号", () => {
    const detail = buildToolDetail(
      tool({
        kind: "read-file",
        rawInput: { file_path: "src/app.ts" },
        display: { type: "file", path: "src/app.ts", lineStart: 68, lineEnd: 72, text: "const a = 1;" },
      }),
    );

    expect(detail).toEqual({
      type: "text",
      text: "const a = 1;",
      path: "src/app.ts",
      lineStart: 68,
      lineEnd: 72,
      truncated: false,
    });
  });

  // 只有计数等结构化字段时没有可读文本，不能渲染空详情区。
  test("无可读文本时返回 null", () => {
    expect(buildToolDetail(tool({ rawOutput: { count: 1 } }))).toBeNull();
    expect(buildToolDetail(tool())).toBeNull();
    expect(buildToolDetail(tool({ rawOutput: { output: "   " } }))).toBeNull();
  });

  // 超长输出必须截断，避免单条命令输出拖垮时间线渲染。
  test("超长输出截断并标记", () => {
    const detail = buildToolDetail(tool({ kind: "bash", rawOutput: { output: "x".repeat(5000) } }));

    if (detail?.type !== "text") throw new Error("expected text detail");
    expect(detail.truncated).toBe(true);
    expect(detail.text.length).toBeLessThanOrEqual(4001);
    expect(detail.text.endsWith("…")).toBe(true);
  });
});
