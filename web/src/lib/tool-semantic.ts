import type { ToolCallDisplay, ToolCardKind } from "./types";

export type ToolSemantic = "ask-user-question" | "todo" | "subtask" | "read" | "write" | "edit" | "other";

export interface ToolSemanticInput {
  name?: string;
  rawInput?: Record<string, unknown>;
  display?: ToolCallDisplay;
}

/** 将工具名归一化为稳定标识，兼容大小写、snake_case 和分隔符变体。 */
export function normalizeToolName(name: string | undefined): string {
  return (name ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * 工具语义的唯一前端分类入口。名称是权威信号，display/rawInput 仅在名称未知时兜底。
 */
export function classifyToolSemantic({ name, rawInput, display }: ToolSemanticInput): ToolSemantic {
  const normalized = normalizeToolName(name);
  const compactName = (name ?? "").toLowerCase();
  if (normalized === "askuserquestion") return "ask-user-question";
  if (compactName.includes("todowrite") || compactName.includes("todo_write") || compactName.includes("todo-write")) {
    return "todo";
  }
  if (normalized === "task" || normalized === "subtask" || normalized === "agent") return "subtask";
  if (normalized === "read" || normalized === "readfile") return "read";
  if (normalized === "write" || normalized === "writefile") return "write";
  if (normalized === "edit" || normalized === "strreplace" || normalized === "editfile") return "edit";
  // 兼容旧扩展工具名；write 优先，且不会匹配 todowrite（已在上方明确处理）。
  if (normalized.includes("write")) return "write";
  if (normalized.includes("edit")) return "edit";

  if (normalized) return "other";
  if (display?.type === "diff") return "edit";
  if (display?.type === "directory") return "read";
  if (display?.type === "file") {
    if (typeof rawInput?.oldText === "string" || typeof rawInput?.old_string === "string") return "edit";
    if (typeof rawInput?.newText === "string" || typeof rawInput?.content === "string") return "write";
    return "read";
  }
  if (!normalized && (Array.isArray(rawInput?.todos) || Array.isArray(rawInput?.tasks))) return "todo";
  if (
    typeof rawInput?.subagent_type === "string" ||
    typeof rawInput?.subagent_name === "string" ||
    typeof rawInput?.prompt === "string"
  ) {
    return "subtask";
  }
  return "other";
}

export function semanticToToolCardKind(semantic: ToolSemantic): ToolCardKind | undefined {
  switch (semantic) {
    case "ask-user-question":
      return "question";
    case "todo":
      return "todo";
    case "subtask":
      return "task";
    case "read":
      return "read-file";
    case "write":
      return "write";
    case "edit":
      return "edit";
    default:
      return;
  }
}
