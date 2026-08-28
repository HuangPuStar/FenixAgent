import { describe, expect, test } from "bun:test";
import {
  extractDirectoryEntryCount,
  extractDisplayMeta,
  isOpencodeDirectoryOutput,
  isOpencodeFileOutput,
  resolveToolCardKind,
} from "../../components/chat/narrators/helpers";
import type { ToolCallData } from "../lib/types";

function tool(
  rawInput?: Record<string, unknown>,
  display?: ToolCallData["display"],
): Pick<ToolCallData, "display" | "rawInput" | "rawOutput"> {
  return { display, rawInput };
}

describe("narrators helpers 高缺口纯逻辑", () => {
  // metadata.preview 中的非空行代表目录实际展示的条目数。
  test("目录预览按非空行统计条目", () => {
    expect(extractDirectoryEntryCount({ metadata: { preview: "src\n\n  tests  \n" } })).toBe(2);
  });

  // preview 是最可靠来源，即使 output 里有不同数字也必须优先采用 preview。
  test("目录预览优先于 output 中的条目文案", () => {
    expect(extractDirectoryEntryCount({ metadata: { preview: "a\nb" }, output: "(99 entries)" })).toBe(2);
  });

  // 缺少预览时可从复数 entries 文案恢复目录条目数。
  test("entries 文案可解析", () => {
    expect(extractDirectoryEntryCount({ output: "listing complete (1 entries)" })).toBe(1);
  });

  // entries 文案大小写不应影响兼容不同工具输出的解析。
  test("大写 entries 文案可解析", () => {
    expect(extractDirectoryEntryCount({ output: "(12 ENTRIES)" })).toBe(12);
  });

  // 数字文案不可用时，XML entries 块仍能提供兜底计数。
  test("entries XML 块按非空行兜底计数", () => {
    expect(extractDirectoryEntryCount({ output: "<entries>one\n\n two \nthree</entries>" })).toBe(3);
  });

  // 空预览、零条目和空 XML 块都不应伪造可展示的目录数量。
  test("没有有效目录条目时返回 undefined", () => {
    expect(
      extractDirectoryEntryCount({ metadata: { preview: " \n" }, output: "(0 entries)<entries>\n</entries>" }),
    ).toBeUndefined();
  });

  // 原始输出不是对象时应安全拒绝，而非尝试读取属性。
  test("非对象目录输出返回 undefined", () => {
    expect(extractDirectoryEntryCount("(2 entries)")).toBeUndefined();
  });

  // 目录标记要求精确的 type 标签，避免把普通文本误识别为目录。
  test("精确目录标签识别为目录输出", () => {
    expect(isOpencodeDirectoryOutput({ output: "<type>directory</type>" })).toBe(true);
  });

  // 不完整目录标签不能触发目录分支。
  test("不完整目录标签不被识别", () => {
    expect(isOpencodeDirectoryOutput({ output: "<type>directory" })).toBe(false);
  });

  // 文件输出同时需要路径和 file 类型，防止单一标签造成误判。
  test("路径与文件类型标签共同识别文件输出", () => {
    expect(isOpencodeFileOutput({ output: "<path>src/a.ts</path><type>file</type>" })).toBe(true);
  });

  // 缺少路径标签时 file 类型不足以证明这是可定位的文件输出。
  test("缺少路径标签不识别文件输出", () => {
    expect(isOpencodeFileOutput({ output: "<type>file</type>" })).toBe(false);
  });

  // 顶层 display 是最新协议字段，必须压过其他两个兼容来源。
  test("顶层 display 优先于嵌套来源", () => {
    expect(
      extractDisplayMeta(
        { metadata: { display: { type: "directory" } } },
        { display: { type: "diff" } },
        { type: "file", path: "src/a.ts", lineStart: 3, truncated: true },
      ),
    ).toEqual({
      type: "file",
      path: "src/a.ts",
      lineStart: 3,
      lineEnd: undefined,
      totalLines: undefined,
      text: undefined,
      truncated: true,
    });
  });

  // 没有顶层 display 时应读取 rawOutput 的 metadata.display。
  test("嵌套 metadata.display 作为第二优先级", () => {
    expect(extractDisplayMeta({ metadata: { display: { type: "diff", text: "patch" } } })).toEqual({
      type: "diff",
      path: undefined,
      lineStart: undefined,
      lineEnd: undefined,
      totalLines: undefined,
      text: "patch",
      truncated: undefined,
    });
  });

  // 仅 relay 元数据可用时，_meta.display 是最后的兼容回退。
  test("relay 元数据 display 作为最后回退", () => {
    expect(extractDisplayMeta(undefined, { display: { type: "directory", totalLines: 8 } })).toEqual({
      type: "directory",
      path: undefined,
      lineStart: undefined,
      lineEnd: undefined,
      totalLines: 8,
      text: undefined,
      truncated: undefined,
    });
  });

  // 缺少字符串 type 的 display 不是有效展示元数据。
  test("无有效 type 的 display 返回 undefined", () => {
    expect(extractDisplayMeta({ metadata: { display: { type: 42 } } }, { display: { path: "a.ts" } })).toBeUndefined();
  });

  // directory display 类型无需读取输入字段，直接归类为目录读取工具。
  test("directory display 解析为 read-directory", () => {
    expect(resolveToolCardKind(tool({ path: "src" }, { type: "directory" }))).toBe("read-directory");
  });

  // file display 配合 content 表示新建或覆盖文件，而非普通读取。
  test("file display 配合 content 解析为 write", () => {
    expect(resolveToolCardKind(tool({ content: "new file" }, { type: "file" }))).toBe("write");
  });

  // old_string 是编辑操作的结构化信号，应比普通路径读取更具体。
  test("file display 配合 old_string 解析为 edit", () => {
    expect(resolveToolCardKind(tool({ old_string: "before" }, { type: "file" }))).toBe("edit");
  });

  // command 字段具有最高的无 display 输入优先级，避免把附带 path 的命令误归为读取。
  test("命令输入优先解析为 bash", () => {
    expect(resolveToolCardKind(tool({ command: "ls", path: "src" }))).toBe("bash");
  });

  // pattern 与路径共同出现是内容搜索，而非仅按 pattern 的文件枚举。
  test("带路径的 pattern 解析为 grep", () => {
    expect(resolveToolCardKind(tool({ pattern: "TODO", path: "src" }))).toBe("grep");
  });

  // 仅 pattern 缺少搜索范围时保留 glob 语义。
  test("仅 pattern 解析为 glob", () => {
    expect(resolveToolCardKind(tool({ pattern: "**/*.ts" }))).toBe("glob");
  });

  // todos 数组是待办工具的结构化协议信号。
  test("todos 数组解析为 todo", () => {
    expect(resolveToolCardKind(tool({ todos: [] }))).toBe("todo");
  });

  // 任务提示词是子代理调用的信号，应归类为 task。
  test("prompt 字段解析为 task", () => {
    expect(resolveToolCardKind(tool({ prompt: "检查实现" }))).toBe("task");
  });

  // 无 display 且没有任何已知输入结构时，必须安全回退 unknown。
  test("未知输入结构回退 unknown", () => {
    expect(resolveToolCardKind(tool({ enabled: true }))).toBe("unknown");
  });
});
