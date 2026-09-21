// 统一工具语义分类测试（CE 阶段 2 §1.6 T6c1 从
// `packages/agent-runtime/web/src/__tests__/tool-semantic.test.ts` 迁入）。
// 导入路径按 A -> B 映射表改写为包内相对路径；`PermissionRequest` 不再依赖
// `@fenix/chat-channel`，改用包内 `../chat/types` 的同构类型。
// `derivePendingPermissions` 的 Ask 过滤在包内改为注入式，测试按宿主装配
// （`web/chat/shell/ChatInterface.tsx`）传入等价的 `shouldSuppress` 判定。
import { describe, expect, test } from "bun:test";
import { derivePendingPermissions } from "../chat/lib/chat-derived-state";
import { extractChangedFiles } from "../chat/lib/extract-changed-files";
import { classifyToolSemantic, normalizeToolName } from "../chat/lib/tool-semantic";
import { resolveToolCardKind } from "../chat/narrators/helpers";
import type { PermissionRequest, ThreadEntry, ToolCallData } from "../chat/types";

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
    // 包内把「Ask 由 QuestionPanel 承接」的判定收敛为注入点，这里按宿主装配传入等价谓词
    const shouldSuppress = (toolName: string) => classifyToolSemantic({ name: toolName }) === "ask-user-question";
    expect(derivePendingPermissions(permissions, { shouldSuppress }).map((item) => item.requestId)).toEqual(["bash"]);
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
