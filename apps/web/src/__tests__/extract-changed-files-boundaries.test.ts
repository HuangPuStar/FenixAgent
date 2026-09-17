import { describe, expect, test } from "bun:test";
import { extractChangedFiles } from "../lib/extract-changed-files";
import type { ThreadEntry, ToolCallData } from "../lib/types";

function toolCall(overrides: Partial<ToolCallData> = {}): ThreadEntry {
  return {
    type: "tool_call",
    toolCall: {
      id: "tool",
      title: "Read",
      status: "complete",
      ...overrides,
    },
  };
}

function files(entries: ThreadEntry[]) {
  return extractChangedFiles(entries);
}

describe("extractChangedFiles 纯逻辑边界", () => {
  // 空时间线没有文件修改，结果应为空数组。
  test("空条目返回空数组", () => expect(files([])).toEqual([]));

  // 普通用户消息不是工具调用，不应被解析为文件变更。
  test("忽略用户消息", () => expect(files([{ type: "user_message", id: "u", content: "编辑 a.ts" }])).toEqual([]));

  // 助手消息不是工具调用，不应被解析为文件变更。
  test("忽略助手消息", () => expect(files([{ type: "assistant_message", id: "a", chunks: [] }])).toEqual([]));

  // 读取工具不属于写入工具，不应提取 rawInput 路径。
  test("忽略读取工具路径", () =>
    expect(files([toolCall({ title: "Read", rawInput: { file_path: "a.ts" } })])).toEqual([]));

  // Bash 命令中的路径无法可靠解析，必须忽略。
  test("忽略 Bash 工具路径", () =>
    expect(files([toolCall({ title: "Bash", rawInput: { path: "a.ts" } })])).toEqual([]));

  // Edit 工具应从 file_path 提取编辑文件。
  test("从 Edit 的 file_path 提取编辑文件", () =>
    expect(files([toolCall({ title: "Edit", rawInput: { file_path: "src/a.ts" } })])).toEqual([
      { path: "src/a.ts", type: "edit" },
    ]));

  // 工具名大小写不应影响 edit 推断。
  test("不区分大小写识别 edit", () =>
    expect(files([toolCall({ title: "eDiT", rawInput: { file_path: "a.ts" } })])).toEqual([
      { path: "a.ts", type: "edit" },
    ]));

  // 含 edit 的自定义工具名也应识别为编辑。
  test("识别含 edit 的工具名", () =>
    expect(files([toolCall({ title: "MultiEdit", rawInput: { file_path: "a.ts" } })])).toEqual([
      { path: "a.ts", type: "edit" },
    ]));

  // Write 工具应从 path 提取新建或覆盖文件。
  test("从 Write 的 path 提取写入文件", () =>
    expect(files([toolCall({ title: "Write", rawInput: { path: "src/a.ts" } })])).toEqual([
      { path: "src/a.ts", type: "write" },
    ]));

  // 工具名大小写不应影响 write 推断。
  test("不区分大小写识别 write", () =>
    expect(files([toolCall({ title: "WRITE", rawInput: { path: "a.ts" } })])).toEqual([
      { path: "a.ts", type: "write" },
    ]));

  // 同时含 write 和 edit 时必须优先认定为 write。
  test("write 优先于 edit", () =>
    expect(files([toolCall({ title: "write_edit_tool", rawInput: { path: "a.ts" } })])).toEqual([
      { path: "a.ts", type: "write" },
    ]));

  // str_replace 是历史编辑工具名，应映射为 edit。
  test("识别 str_replace", () =>
    expect(files([toolCall({ title: "str_replace", rawInput: { file_path: "a.ts" } })])).toEqual([
      { path: "a.ts", type: "edit" },
    ]));

  // 标题先归一化为小写，历史工具名也应大小写无关地识别。
  test("大写 str_replace 映射为 edit", () =>
    expect(files([toolCall({ title: "STR_REPLACE", rawInput: { file_path: "a.ts" } })])).toEqual([
      { path: "a.ts", type: "edit" },
    ]));

  // file_path 优先于 path，避免同一调用产生两个记录。
  test("优先使用 file_path", () =>
    expect(files([toolCall({ title: "Edit", rawInput: { file_path: "a.ts", path: "b.ts" } })])).toEqual([
      { path: "a.ts", type: "edit" },
    ]));

  // 空 file_path 会回退到 path。
  test("空 file_path 回退到 path", () =>
    expect(files([toolCall({ title: "Edit", rawInput: { file_path: "", path: "b.ts" } })])).toEqual([
      { path: "b.ts", type: "edit" },
    ]));

  // 空 path 不是有效文件路径。
  test("忽略空 path", () => expect(files([toolCall({ title: "Write", rawInput: { path: "" } })])).toEqual([]));

  // 非字符串 file_path 不能被错误转换为路径。
  test("忽略数值 file_path", () =>
    expect(files([toolCall({ title: "Edit", rawInput: { file_path: 1 } })])).toEqual([]));

  // 非字符串 path 不能被错误转换为路径。
  test("忽略对象 path", () => expect(files([toolCall({ title: "Write", rawInput: { path: {} } })])).toEqual([]));

  // 缺少 rawInput 时应安全返回空结果。
  test("缺少 rawInput 返回空数组", () => expect(files([toolCall({ title: "Edit" })])).toEqual([]));

  // 空 rawInput 时应安全返回空结果。
  test("空 rawInput 返回空数组", () => expect(files([toolCall({ title: "Write", rawInput: {} })])).toEqual([]));

  // 无关工具即使携带路径也不应产生变更。
  test("忽略未知工具路径", () =>
    expect(files([toolCall({ title: "Deploy", rawInput: { path: "a.ts" } })])).toEqual([]));

  // 首次出现的同一路径应保留其编辑类型。
  test("重复路径保留首次 edit 类型", () =>
    expect(
      files([
        toolCall({ title: "Edit", rawInput: { path: "a.ts" } }),
        toolCall({ id: "two", title: "Write", rawInput: { path: "a.ts" } }),
      ]),
    ).toEqual([{ path: "a.ts", type: "edit" }]));

  // 首次出现的写入类型不能被后续编辑覆盖。
  test("重复路径保留首次 write 类型", () =>
    expect(
      files([
        toolCall({ title: "Write", rawInput: { path: "a.ts" } }),
        toolCall({ id: "two", title: "Edit", rawInput: { path: "a.ts" } }),
      ]),
    ).toEqual([{ path: "a.ts", type: "write" }]));

  // 结果必须按路径字母序展示。
  test("按路径字母序排序", () =>
    expect(
      files([
        toolCall({ title: "Write", rawInput: { path: "z.ts" } }),
        toolCall({ id: "two", title: "Edit", rawInput: { path: "a.ts" } }),
      ]),
    ).toEqual([
      { path: "a.ts", type: "edit" },
      { path: "z.ts", type: "write" },
    ]));

  // 路径排序应保留目录层级字符本身。
  test("排序保留目录路径", () =>
    expect(
      files([
        toolCall({ title: "Write", rawInput: { path: "src/z.ts" } }),
        toolCall({ id: "two", title: "Write", rawInput: { path: "src/a.ts" } }),
      ]),
    ).toEqual([
      { path: "src/a.ts", type: "write" },
      { path: "src/z.ts", type: "write" },
    ]));

  // 空 content 不应阻止 rawInput 兜底。
  test("空 content 使用 rawInput 兜底", () =>
    expect(files([toolCall({ title: "Edit", content: [], rawInput: { path: "a.ts" } })])).toEqual([
      { path: "a.ts", type: "edit" },
    ]));

  // 非 diff 内容不应阻止 rawInput 兜底。
  test("非 diff 内容使用 rawInput 兜底", () =>
    expect(
      files([
        toolCall({
          title: "Write",
          content: [{ type: "content", content: { type: "text", text: "完成" } }],
          rawInput: { path: "a.ts" },
        }),
      ]),
    ).toEqual([{ path: "a.ts", type: "write" }]));

  // diff 路径是最高优先级的信息源。
  test("diff 路径优先于 rawInput", () =>
    expect(
      files([
        toolCall({
          title: "Edit",
          content: [{ type: "diff", path: "diff.ts", newText: "" }],
          rawInput: { path: "raw.ts" },
        }),
      ]),
    ).toEqual([{ path: "diff.ts", type: "edit" }]));

  // Write 工具的 diff 也应映射为 write。
  test("Write 的 diff 映射为 write", () =>
    expect(files([toolCall({ title: "Write", content: [{ type: "diff", path: "a.ts", newText: "" }] })])).toEqual([
      { path: "a.ts", type: "write" },
    ]));

  // 未知工具的 diff 使用安全的 edit 默认类型。
  test("未知工具的 diff 默认 edit", () =>
    expect(files([toolCall({ title: "Patch", content: [{ type: "diff", path: "a.ts", newText: "" }] })])).toEqual([
      { path: "a.ts", type: "edit" },
    ]));

  // 无路径的 diff 不应产生空路径记录。
  test("忽略无路径 diff", () =>
    expect(files([toolCall({ title: "Edit", content: [{ type: "diff", path: "", newText: "" }] })])).toEqual([]));

  // 空路径 diff 不应产生空路径记录。
  test("忽略空路径 diff", () =>
    expect(files([toolCall({ title: "Edit", content: [{ type: "diff", path: "", newText: "" }] })])).toEqual([]));

  // 多个 diff 应逐一提取全部路径。
  test("提取多个 diff 路径", () =>
    expect(
      files([
        toolCall({
          title: "Edit",
          content: [
            { type: "diff", path: "b.ts", newText: "" },
            { type: "diff", path: "a.ts", newText: "" },
          ],
        }),
      ]),
    ).toEqual([
      { path: "a.ts", type: "edit" },
      { path: "b.ts", type: "edit" },
    ]));

  // 同一调用内重复 diff 路径只保留一次。
  test("同调用 diff 路径去重", () =>
    expect(
      files([
        toolCall({
          title: "Edit",
          content: [
            { type: "diff", path: "a.ts", newText: "" },
            { type: "diff", path: "a.ts", newText: "" },
          ],
        }),
      ]),
    ).toEqual([{ path: "a.ts", type: "edit" }]));

  // 有效 diff 存在时不得再加入 rawInput 路径。
  test("有效 diff 阻止 rawInput 兜底", () =>
    expect(
      files([
        toolCall({
          title: "Write",
          content: [{ type: "diff", path: "diff.ts", newText: "" }],
          rawInput: { file_path: "raw.ts" },
        }),
      ]),
    ).toEqual([{ path: "diff.ts", type: "write" }]));

  // 子条目中的编辑文件也属于变更结果。
  test("递归提取子条目的编辑文件", () =>
    expect(
      files([toolCall({ title: "Task", subEntries: [toolCall({ title: "Edit", rawInput: { path: "child.ts" } })] })]),
    ).toEqual([{ path: "child.ts", type: "edit" }]));

  // 子条目中的写入文件也属于变更结果。
  test("递归提取子条目的写入文件", () =>
    expect(
      files([toolCall({ title: "Task", subEntries: [toolCall({ title: "Write", rawInput: { path: "child.ts" } })] })]),
    ).toEqual([{ path: "child.ts", type: "write" }]));

  // 没有 content 的父工具也必须继续遍历子条目。
  test("无 content 的父工具仍递归子条目", () =>
    expect(
      files([toolCall({ title: "Task", subEntries: [toolCall({ title: "Edit", rawInput: { path: "child.ts" } })] })]),
    ).toEqual([{ path: "child.ts", type: "edit" }]));

  // 有效 diff 的父工具仍需遍历子条目。
  test("有 diff 的父工具仍递归子条目", () =>
    expect(
      files([
        toolCall({
          title: "Edit",
          content: [{ type: "diff", path: "parent.ts", newText: "" }],
          subEntries: [toolCall({ title: "Write", rawInput: { path: "child.ts" } })],
        }),
      ]),
    ).toEqual([
      { path: "child.ts", type: "write" },
      { path: "parent.ts", type: "edit" },
    ]));

  // 多层 Task 嵌套应递归到最深层。
  test("递归提取多层子条目", () =>
    expect(
      files([
        toolCall({
          title: "Task",
          subEntries: [
            toolCall({ title: "Task", subEntries: [toolCall({ title: "Write", rawInput: { path: "deep.ts" } })] }),
          ],
        }),
      ]),
    ).toEqual([{ path: "deep.ts", type: "write" }]));

  // 子条目与父条目相同路径时，父条目先出现所以应优先。
  test("父条目路径优先于子条目", () =>
    expect(
      files([
        toolCall({
          title: "Edit",
          rawInput: { path: "same.ts" },
          subEntries: [toolCall({ title: "Write", rawInput: { path: "same.ts" } })],
        }),
      ]),
    ).toEqual([{ path: "same.ts", type: "edit" }]));

  // 子条目可包含非工具消息，遍历时应安全忽略。
  test("子条目忽略非工具消息", () =>
    expect(
      files([toolCall({ title: "Task", subEntries: [{ type: "assistant_message", id: "a", chunks: [] }] })]),
    ).toEqual([]));

  // Unicode 路径应完整保留而非被编码或截断。
  test("保留 Unicode 路径", () =>
    expect(files([toolCall({ title: "Write", rawInput: { path: "目录/报告.ts" } })])).toEqual([
      { path: "目录/报告.ts", type: "write" },
    ]));

  // 含空格路径仍是合法路径，应完整保留。
  test("保留含空格路径", () =>
    expect(files([toolCall({ title: "Edit", rawInput: { path: "src/a file.ts" } })])).toEqual([
      { path: "src/a file.ts", type: "edit" },
    ]));

  // 点文件是合法路径，不能被当作空值。
  test("保留点文件路径", () =>
    expect(files([toolCall({ title: "Edit", rawInput: { file_path: ".env.example" } })])).toEqual([
      { path: ".env.example", type: "edit" },
    ]));

  // 绝对路径只做记录，不应被改写。
  test("保留绝对路径", () =>
    expect(files([toolCall({ title: "Write", rawInput: { path: "/tmp/a.ts" } })])).toEqual([
      { path: "/tmp/a.ts", type: "write" },
    ]));

  // 路径中的换行字符不应导致解析器崩溃。
  test("保留含换行路径", () =>
    expect(files([toolCall({ title: "Write", rawInput: { path: "a\nb.ts" } })])).toEqual([
      { path: "a\nb.ts", type: "write" },
    ]));

  // 重复调用不应修改输入中的 rawInput 或条目顺序。
  test("不修改输入条目", () => {
    const entries = [
      toolCall({ title: "Write", rawInput: { path: "b.ts" } }),
      toolCall({ id: "two", title: "Edit", rawInput: { path: "a.ts" } }),
    ];
    const snapshot = structuredClone(entries);
    files(entries);
    expect(entries).toEqual(snapshot);
  });

  // 返回结果被调用方修改后，不应污染下一次计算。
  test("每次返回独立结果", () => {
    const entries = [toolCall({ title: "Write", rawInput: { path: "a.ts" } })];
    const result = files(entries);
    result[0]!.path = "changed.ts";
    expect(files(entries)).toEqual([{ path: "a.ts", type: "write" }]);
  });

  // 输入中的 content 数组不应因提取过程被修改。
  test("不修改 diff 内容数组", () => {
    const content: ToolCallData["content"] = [{ type: "diff", path: "a.ts", newText: "" }];
    const entries = [toolCall({ title: "Edit", content })];
    files(entries);
    expect(content).toEqual([{ type: "diff", path: "a.ts", newText: "" }]);
  });

  // 输入中的 subEntries 数组不应因递归遍历被修改。
  test("不修改子条目数组", () => {
    const subEntries = [toolCall({ title: "Write", rawInput: { path: "child.ts" } })];
    files([toolCall({ title: "Task", subEntries })]);
    expect(subEntries).toEqual([toolCall({ title: "Write", rawInput: { path: "child.ts" } })]);
  });
});
