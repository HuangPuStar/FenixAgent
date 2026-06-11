import { describe, expect, test } from "bun:test";
import { extractChangedFiles } from "../lib/extract-changed-files";
import type { ThreadEntry } from "../lib/types";

describe("extractChangedFiles", () => {
  // 空 entries 返回空数组
  test("空 entries 返回空数组", () => {
    expect(extractChangedFiles([])).toEqual([]);
  });

  // 非 tool_call 条目忽略
  test("非 tool_call 条目被忽略", () => {
    const entries: ThreadEntry[] = [
      { type: "user_message", id: "1", content: "hello" },
      { type: "assistant_message", id: "2", chunks: [] },
    ];
    expect(extractChangedFiles(entries)).toEqual([]);
  });

  // diff content 优先提取路径，edit 工具类型
  test("从 content[].type===diff 提取路径，类型为 edit", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc1",
          title: "Edit",
          status: "complete",
          content: [
            { type: "diff", path: "src/foo.ts", newText: "new" },
            { type: "diff", path: "src/bar.ts", newText: "new" },
          ],
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([
      { path: "src/bar.ts", type: "edit" },
      { path: "src/foo.ts", type: "edit" },
    ]);
  });

  // write 工具的 diff 类型为 write
  test("write 工具的 diff 类型为 write", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc-w",
          title: "Write",
          status: "complete",
          content: [{ type: "diff", path: "src/new.ts", newText: "new" }],
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([{ path: "src/new.ts", type: "write" }]);
  });

  // 工具名 edit/write 兜底，从 rawInput.file_path 提取，类型 edit
  test("工具名包含 edit 时从 rawInput.file_path 兜底提取，类型 edit", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc2",
          title: "str_replace_based_edit_tool",
          status: "complete",
          rawInput: { file_path: "src/utils.ts" },
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([{ path: "src/utils.ts", type: "edit" }]);
  });

  // 工具名包含 write，从 rawInput.path 提取，类型 write
  test("工具名包含 write 时从 rawInput.path 兜底提取，类型 write", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc3",
          title: "write_file",
          status: "complete",
          rawInput: { path: "src/new-file.ts" },
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([{ path: "src/new-file.ts", type: "write" }]);
  });

  // bash 不提取
  test("bash 工具不提取路径", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc4",
          title: "Bash",
          status: "complete",
          rawInput: { command: "rm -rf src/foo.ts" },
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([]);
  });

  // 去重，同路径以首次出现类型为准
  test("相同路径去重，以首次出现的类型为准", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc5",
          title: "Edit",
          status: "complete",
          content: [{ type: "diff", path: "src/foo.ts", newText: "v1" }],
        },
      },
      {
        type: "tool_call",
        toolCall: {
          id: "tc6",
          title: "Write",
          status: "complete",
          content: [{ type: "diff", path: "src/foo.ts", newText: "v2" }],
        },
      },
    ];
    // 首次出现是 edit，以 edit 为准
    expect(extractChangedFiles(entries)).toEqual([{ path: "src/foo.ts", type: "edit" }]);
  });

  // 递归 subEntries
  test("递归处理 subEntries", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc7",
          title: "Task",
          status: "complete",
          subEntries: [
            {
              type: "tool_call",
              toolCall: {
                id: "tc8",
                title: "Edit",
                status: "complete",
                content: [{ type: "diff", path: "src/nested.ts", newText: "x" }],
              },
            },
          ],
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([{ path: "src/nested.ts", type: "edit" }]);
  });

  // str_replace 精确匹配时从 rawInput.file_path 兜底提取
  test("工具名精确等于 str_replace 时从 rawInput.file_path 兜底提取", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc-sr",
          title: "str_replace",
          status: "complete",
          rawInput: { file_path: "src/target.ts" },
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([{ path: "src/target.ts", type: "edit" }]);
  });

  // diff content 优先于 rawInput.file_path（核心优先级保证）
  test("有 diff content 时不读取 rawInput.file_path（diff 优先）", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc-prio",
          title: "Edit",
          status: "complete",
          content: [{ type: "diff", path: "src/from-diff.ts", newText: "" }],
          rawInput: { file_path: "src/from-raw-input.ts" },
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([{ path: "src/from-diff.ts", type: "edit" }]);
  });

  // 排序
  test("结果按字母序排序", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc9",
          title: "Edit",
          status: "complete",
          content: [
            { type: "diff", path: "src/z.ts", newText: "" },
            { type: "diff", path: "src/a.ts", newText: "" },
            { type: "diff", path: "src/m.ts", newText: "" },
          ],
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([
      { path: "src/a.ts", type: "edit" },
      { path: "src/m.ts", type: "edit" },
      { path: "src/z.ts", type: "edit" },
    ]);
  });
});
