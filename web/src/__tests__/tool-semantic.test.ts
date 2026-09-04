import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@fenix/chat-channel";
import { derivePendingPermissions } from "@/components/chat/chat-derived-state";
import { resolveToolCardKind } from "@/components/chat/narrators/helpers";
import { extractChangedFiles } from "../lib/extract-changed-files";
import { classifyToolSemantic, normalizeToolName } from "../lib/tool-semantic";
import type { ThreadEntry, ToolCallData } from "../lib/types";

function tool(title: string, rawInput?: Record<string, unknown>): ToolCallData {
  const semantic = classifyToolSemantic({ name: title, rawInput });
  return { id: title, title, status: "complete", rawInput, semantic };
}

describe("统一工具语义分类", () => {
  // 工具名归一化必须消除大小写和分隔符差异，保证各运行时名称进入同一语义。
  test("normalizes tool name variants", () => {
    expect(normalizeToolName("ask_user_question")).toBe("askuserquestion");
    expect(normalizeToolName("Todo-Write")).toBe("todowrite");
  });

  // Ask、Todo 和子任务名称变体必须优先于输入结构被稳定识别。
  test("classifies interaction and panel tools by name", () => {
    for (const name of ["AskUserQuestion", "Askuserquestion", "ask_user_question"]) {
      expect(classifyToolSemantic({ name, rawInput: { prompt: "不会误判成 task" } })).toBe("ask-user-question");
    }
    for (const name of ["TodoWrite", "todo_write", "todowrite"]) {
      expect(classifyToolSemantic({ name })).toBe("todo");
    }
    for (const name of ["Task", "Subtask", "Agent"]) {
      expect(classifyToolSemantic({ name })).toBe("subtask");
    }
  });

  // 文件工具按名称区分读写编辑，TodoWrite 不能再被普通 Write 规则抢先命中。
  test("classifies file tools without confusing TodoWrite", () => {
    expect(classifyToolSemantic({ name: "Read" })).toBe("read");
    expect(classifyToolSemantic({ name: "Write" })).toBe("write");
    expect(classifyToolSemantic({ name: "Edit" })).toBe("edit");
    expect(resolveToolCardKind(tool("TodoWrite"))).toBe("todo");
    expect(resolveToolCardKind(tool("Write"))).toBe("write");
  });

  // 前端防御层必须隐藏错误投影为权限的 Ask，但保留真实 Bash 权限请求。
  test("filters Ask permission projections only", () => {
    const permissions = [
      { id: "ask", tool: "Askuserquestion", status: "pending", args: {}, options: [] },
      { id: "bash", tool: "Bash", status: "pending", args: {}, options: [] },
    ] as unknown as PermissionRequest[];
    expect(derivePendingPermissions(permissions).map((item) => item.requestId)).toEqual(["bash"]);
  });

  // Changes 面板必须只收集统一分类为 write/edit 的文件工具，并忽略 TodoWrite。
  test("extracts changes from semantic file tools", () => {
    const entries: ThreadEntry[] = [
      { type: "tool_call", toolCall: tool("Write", { file_path: "a.ts", content: "x" }) },
      { type: "tool_call", toolCall: tool("Edit", { path: "b.ts", old_string: "x" }) },
      { type: "tool_call", toolCall: tool("TodoWrite", { path: "wrong.ts", todos: [] }) },
    ];
    expect(extractChangedFiles(entries)).toEqual([
      { path: "a.ts", type: "write" },
      { path: "b.ts", type: "edit" },
    ]);
  });
});
