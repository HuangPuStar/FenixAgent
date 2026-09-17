import { classifyToolSemantic } from "./tool-semantic";
import type { TodoChange, TodoChangeKind, TodoItem, TodoStatus } from "./types";

/** 从 TodoWrite 原始入参解析待办列表；不存在待办字段时返回 null。 */
export function getTodosFromRawInput(rawInput: Record<string, unknown> | undefined): TodoItem[] | null {
  const rawTodos = rawInput?.todos ?? rawInput?.tasks;
  if (!Array.isArray(rawTodos)) return null;

  return rawTodos
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      content: typeof item.content === "string" ? item.content : String(item.content ?? ""),
      status: validateTodoStatus(item.status),
      activeForm: typeof item.activeForm === "string" ? item.activeForm : undefined,
    }));
}

/** 从 TodoWrite 原始入参解析待办列表；不存在待办字段时返回空数组供面板空态使用。 */
export function parseTodosFromRawInput(rawInput: Record<string, unknown>): TodoItem[] {
  return getTodosFromRawInput(rawInput) ?? [];
}

/** 判断工具调用是否为包含 TodoWrite 入参的调用。 */
export function isTodoWriteToolCall(title: string, rawInput?: Record<string, unknown>): boolean {
  return !!rawInput && classifyToolSemantic({ name: title, rawInput }) === "todo";
}

/**
 * 对比两次 TodoWrite 的完整快照，生成当前调用相较上一轮的变更。
 *
 * TodoWrite 未提供稳定条目 ID，因此以 content 及其出现顺序配对同名条目；内容改写会
 * 表达为移除旧条目和新增新条目，避免错误地把两个独立待办合并为一次状态变更。
 */
export function getTodoChanges(previousTodos: TodoItem[], currentTodos: TodoItem[]): TodoChange[] {
  const previousByContent = new Map<string, TodoItem[]>();
  for (const todo of previousTodos) {
    const items = previousByContent.get(todo.content) ?? [];
    items.push(todo);
    previousByContent.set(todo.content, items);
  }

  const changes: TodoChange[] = [];
  const changeIds = new Map<string, number>();
  const addChange = (kind: TodoChangeKind, todo: TodoItem) => {
    const baseId = `${kind}:${todo.content}:${todo.activeForm ?? ""}`;
    const occurrence = changeIds.get(baseId) ?? 0;
    changeIds.set(baseId, occurrence + 1);
    changes.push({ id: `${baseId}:${occurrence}`, kind, todo });
  };

  for (const todo of currentTodos) {
    const previous = previousByContent.get(todo.content)?.shift();
    if (!previous) {
      addChange("added", todo);
      continue;
    }

    const kind = getTodoChangeKind(previous, todo);
    if (kind) addChange(kind, todo);
  }

  for (const remainingTodos of previousByContent.values()) {
    for (const todo of remainingTodos) {
      addChange("removed", todo);
    }
  }

  return changes;
}

function getTodoChangeKind(previous: TodoItem, current: TodoItem): TodoChangeKind | null {
  if (previous.status !== current.status) return current.status;
  if (previous.activeForm !== current.activeForm) return "updated";
  return null;
}

function validateTodoStatus(status: unknown): TodoStatus {
  if (status === "pending" || status === "in_progress" || status === "completed") return status;
  return "pending";
}
