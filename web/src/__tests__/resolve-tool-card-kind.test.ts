import { describe, expect, test } from "bun:test";
import { extractDisplayMeta, resolveToolCardKind } from "@/components/chat/narrators/helpers";
import type { ToolCallData } from "@/src/lib/types";

/** 构造最小工具调用数据，便于测试 */
function makeTool(overrides: Partial<ToolCallData> = {}): ToolCallData {
  return { id: "t1", title: "unknown", status: "complete", ...overrides };
}

// =============================================================================
// extractDisplayMeta — 5 级采集链
// =============================================================================

describe("extractDisplayMeta（5 级采集链）", () => {
  // ① 顶层 toolCall.display 优先级最高
  test("顶层 display 优先级最高", () => {
    const rawOutput = { metadata: { display: { type: "directory", path: "/a" } } };
    const toolCallDisplay = { type: "file", path: "/b" };
    const result = extractDisplayMeta(rawOutput, null, toolCallDisplay);
    expect(result?.type).toBe("file");
    expect(result?.path).toBe("/b");
  });

  // ② rawOutput.metadata.display（opencode 嵌套）
  test("rawOutput.metadata.display 第二优先", () => {
    const rawOutput = { metadata: { display: { type: "directory", path: "/a" } } };
    const result = extractDisplayMeta(rawOutput, null, undefined);
    expect(result?.type).toBe("directory");
  });

  // ③ _meta.display（relay 场景）
  test("_meta.display 第三优先", () => {
    const result = extractDisplayMeta({}, { display: { type: "diff" } }, undefined);
    expect(result?.type).toBe("diff");
  });

  // 全空返回 undefined
  test("无任何 display 时返回 undefined", () => {
    const result = extractDisplayMeta({}, null, undefined);
    expect(result).toBeUndefined();
  });

  // rawOutput 本身非对象不抛错
  test("rawOutput 非对象安全返回", () => {
    const result = extractDisplayMeta("string", null, undefined);
    expect(result).toBeUndefined();
  });

  // _meta.display 无 type 字段时忽略
  test("_meta.display 无 type 字段时忽略", () => {
    const result = extractDisplayMeta({}, { display: { path: "/x" } }, undefined);
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// resolveToolCardKind — 4 级解析链
// =============================================================================

describe("resolveToolCardKind（4 级解析链）", () => {
  // display.type "directory" → "read-directory"
  test("directory → read-directory", () => {
    const tool = makeTool();
    const meta = { display: { type: "directory", path: "/x" } };
    expect(resolveToolCardKind(tool, meta)).toBe("read-directory");
  });

  // display.type "diff" → "edit"
  test("diff → edit", () => {
    const tool = makeTool();
    const meta = { display: { type: "diff" } };
    expect(resolveToolCardKind(tool, meta)).toBe("edit");
  });

  // display.type "file" + write rawInput → "write"
  test("file type + newText → write", () => {
    const tool = makeTool({ rawInput: { file_path: "/a.ts", newText: "hello" } });
    const meta = { display: { type: "file" } };
    expect(resolveToolCardKind(tool, meta)).toBe("write");
  });

  // display.type "file" + edit rawInput → "edit"
  test("file type + old_string → edit", () => {
    const tool = makeTool({ rawInput: { file_path: "/a.ts", old_string: "x" } });
    const meta = { display: { type: "file" } };
    expect(resolveToolCardKind(tool, meta)).toBe("edit");
  });

  // display.type "file" only → "read-file"
  test("file type only → read-file", () => {
    const tool = makeTool({ rawInput: { file_path: "/a.ts" } });
    const meta = { display: { type: "file" } };
    expect(resolveToolCardKind(tool, meta)).toBe("read-file");
  });

  // 无 display → rawInput command → "bash"
  test("rawInput command → bash（无 display）", () => {
    const tool = makeTool({ rawInput: { command: "ls" } });
    expect(resolveToolCardKind(tool)).toBe("bash");
  });

  // 无 display → rawInput url → "web-fetch"
  test("rawInput url → web-fetch（无 display）", () => {
    const tool = makeTool({ rawInput: { url: "https://example.com" } });
    expect(resolveToolCardKind(tool)).toBe("web-fetch");
  });

  // 无 display → rawInput pattern + include → "grep"
  test("rawInput pattern + include → grep（无 display）", () => {
    const tool = makeTool({ rawInput: { pattern: "foo", include: "*.ts" } });
    expect(resolveToolCardKind(tool)).toBe("grep");
  });

  // 无 display → rawInput pattern only → "glob"
  test("rawInput pattern only → glob（无 display）", () => {
    const tool = makeTool({ rawInput: { pattern: "**/*.ts" } });
    expect(resolveToolCardKind(tool)).toBe("glob");
  });

  // 无 display → rawInput query → "web-search"
  test("rawInput query → web-search（无 display）", () => {
    const tool = makeTool({ rawInput: { query: "hello" } });
    expect(resolveToolCardKind(tool)).toBe("web-search");
  });

  // 无匹配 → "unknown"
  test("无匹配返回 unknown", () => {
    const tool = makeTool({ rawInput: { foo: "bar" } });
    expect(resolveToolCardKind(tool)).toBe("unknown");
  });

  // title 含 "bash" 但不应该影响结果（title 不再参与匹配）
  test("title 关键字不影响 kind 判定", () => {
    const tool = makeTool({ title: "some_bash_tool", rawInput: {} });
    expect(resolveToolCardKind(tool)).toBe("unknown");
  });

  // display 来自 tool.display 字段（不走 meta）
  test("display 来自 tool.display 字段时正确映射", () => {
    const tool = makeTool({ display: { type: "directory", path: "/x" } });
    expect(resolveToolCardKind(tool)).toBe("read-directory");
  });

  // cmd 别名 → "bash"
  test("rawInput cmd → bash", () => {
    const tool = makeTool({ rawInput: { cmd: "dir" } });
    expect(resolveToolCardKind(tool)).toBe("bash");
  });

  // file_path + new_text 都检查（写操作的别名）
  test("file_path + content → write", () => {
    const tool = makeTool({ rawInput: { file_path: "/a.ts", content: "new" } });
    const meta = { display: { type: "file" } };
    expect(resolveToolCardKind(tool, meta)).toBe("write");
  });

  // rawInput todos 数组 → todo（opencode todowrite，无 display.type）
  test("rawInput todos → todo", () => {
    const tool = makeTool({ rawInput: { todos: [{ status: "in_progress", content: "测试" }] } });
    expect(resolveToolCardKind(tool)).toBe("todo");
  });

  // rawInput tasks 数组 → todo（兼容 tasks 别名）
  test("rawInput tasks → todo", () => {
    const tool = makeTool({ rawInput: { tasks: [{ id: "t1" }] } });
    expect(resolveToolCardKind(tool)).toBe("todo");
  });

  // rawInput subagent_type → task（opencode subagent 调用）
  test("rawInput subagent_type → task", () => {
    const tool = makeTool({ rawInput: { description: "探索项目", prompt: "ls -la", subagent_type: "explore" } });
    expect(resolveToolCardKind(tool)).toBe("task");
  });

  // rawInput prompt → task（无 subagent_type 但有 prompt）
  test("rawInput prompt → task", () => {
    const tool = makeTool({ rawInput: { description: "test", prompt: "do something" } });
    expect(resolveToolCardKind(tool)).toBe("task");
  });

  // rawInput subagent_name → task（opencode 别名）
  test("rawInput subagent_name → task", () => {
    const tool = makeTool({ rawInput: { subagent_name: "coder" } });
    expect(resolveToolCardKind(tool)).toBe("task");
  });

  // rawInput description 单独不会误判为 task（其他工具也可能有 description）
  test("仅有 description 不判为 task", () => {
    const tool = makeTool({ rawInput: { description: "加载技能" } });
    expect(resolveToolCardKind(tool)).toBe("unknown");
  });
});
