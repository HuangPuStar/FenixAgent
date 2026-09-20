/**
 * Demo 专用投影：`StructuredMessage[]` → `ThreadEntry[]`（纯函数，无副作用）。
 *
 * 来源：`apps/web/src/lib/structured-to-thread.ts` 的 `structuredToThreadEntries` 语义子集，
 * 以及 `apps/web/src/lib/todo.ts` 的 `getTodosFromRawInput` / `getTodoChanges`。
 * 这三段逻辑都属宿主投影层：`ChatInterfaceProps.projectEntries` 要求宿主注入，包内刻意不复制
 * （源实现还依赖 YJS doc 助手与 i18n 单例）。mock 只服务 demo，需要一份与真实宿主输出同形状的
 * 投影，才能让 mock 会话在真实组件上完整渲染，故在此单独实现——**不属于包内公开能力**。
 *
 * 纯化改动点：
 * - 输入直接就是投影输入（无 Chat Doc / YJS 增量派生），只做 `StructuredMessage` → `ThreadEntry`。
 * - `kind` 解析补齐到全部 `ToolCardKind`：源投影只写 `semanticToToolCardKind` 的结果
 *   （bash / grep / glob / web-search 等为 undefined，靠 `narrate` 运行时兜底），
 *   mock 一次性解析到位，使工具卡片配色、图标与 narrator 匹配覆盖全部展示形态
 *   （`ToolCallData.kind` 的既定语义即「由前端投影边界一次性解析」）。
 * - 两套同名异声明的内容块类型（`StructuredToolCallContentBlock` 与协议 `ToolCallContent`）
 *   之间改用显式字段映射，不用双层断言。
 *
 * 演示边界：`StructuredMessage` 的 `user_message` 不承载图片附件（源 `UserMessage` 无该字段，
 * 宿主投影同样会丢），因此图片形态只能在 `createMockChatEntries()` 直供 `ChatView` 的路径展示。
 */

import { classifyToolSemantic, semanticToToolCardKind } from "../lib/tool-semantic";
import { resolveToolCardKind } from "../narrators/helpers";
import type {
  AssistantChunk,
  StructuredMessage,
  StructuredToolCallContentBlock,
  ThreadEntry,
  TodoChange,
  TodoItem,
  TodoStatus,
  ToolCallContent,
  ToolCallData,
  ToolCallMessage,
  ToolCallStatus,
  ToolSemantic,
} from "../types";

/** 结构化工具调用状态 → `ToolCallData.status`。两个联合取值一致，映射保持显式以便同步。 */
const TOOL_STATUS_MAP: Record<ToolCallMessage["status"], ToolCallStatus> = {
  running: "running",
  complete: "complete",
  error: "error",
  waiting_for_confirmation: "waiting_for_confirmation",
  canceled: "canceled",
  rejected: "rejected",
};

/** TodoWrite 协议状态校验；未知取值回退 `pending`。复制自 `apps/web/src/lib/todo.ts` 的 `validateTodoStatus`。 */
function validateTodoStatus(status: unknown): TodoStatus {
  if (status === "pending" || status === "in_progress" || status === "completed") return status;
  return "pending";
}

/** 从 TodoWrite 原始入参解析待办列表；不存在待办字段时返回 null。复制自 `apps/web/src/lib/todo.ts`。 */
function readTodosFromRawInput(rawInput?: Record<string, unknown>): TodoItem[] | null {
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

/** 单条待办的变更类型（复制自 `apps/web/src/lib/todo.ts` 的 `getTodoChangeKind`）。 */
function todoChangeKind(previous: TodoItem, current: TodoItem): TodoChange["kind"] | null {
  if (previous.status !== current.status) return current.status;
  if (previous.activeForm !== current.activeForm) return "updated";
  return null;
}

/**
 * 对比两次 TodoWrite 快照生成增量（按 content 对齐，复制自 `apps/web/src/lib/todo.ts` 的 `getTodoChanges`）。
 *
 * 仅用于历史工具卡片展示（`TodoChanges` 组件）。
 */
function diffTodos(previousTodos: TodoItem[], currentTodos: TodoItem[]): TodoChange[] {
  const previousByContent = new Map<string, TodoItem[]>();
  for (const todo of previousTodos) {
    const items = previousByContent.get(todo.content) ?? [];
    items.push(todo);
    previousByContent.set(todo.content, items);
  }

  const changes: TodoChange[] = [];
  const seen = new Map<string, number>();
  const addChange = (kind: TodoChange["kind"], todo: TodoItem) => {
    const baseId = `${kind}:${todo.content}:${todo.activeForm ?? ""}`;
    const occurrence = seen.get(baseId) ?? 0;
    seen.set(baseId, occurrence + 1);
    changes.push({ id: `${baseId}:${occurrence}`, kind, todo });
  };

  for (const todo of currentTodos) {
    const previous = previousByContent.get(todo.content)?.shift();
    if (!previous) {
      addChange("added", todo);
      continue;
    }
    const kind = todoChangeKind(previous, todo);
    if (kind) addChange(kind, todo);
  }
  for (const remaining of previousByContent.values()) {
    for (const todo of remaining) addChange("removed", todo);
  }
  return changes;
}

/**
 * 结构化内容块 → 协议 `ToolCallContent[]` 的显式字段映射。
 *
 * 两套类型字段同名同义、仅可选性不同，源投影用双层断言跨越；此处显式构造，避免在 mock 中引入断言。
 */
function toToolCallContent(blocks: readonly StructuredToolCallContentBlock[]): ToolCallContent[] {
  return blocks.map((block): ToolCallContent => {
    if (block.type === "diff") {
      return { type: "diff", path: block.path ?? "", oldText: block.oldText ?? null, newText: block.newText ?? "" };
    }
    if (block.type === "terminal") return { type: "terminal", terminalId: block.terminalId ?? "" };
    return { type: "content", content: block.content ?? { type: "text", text: "" } };
  });
}

/** 单个结构化工具调用 → `ThreadEntry`，并把 todo 快照串成增量（`nextTodos` 作为下一次对比的基线）。 */
function projectToolCall(
  message: ToolCallMessage,
  previousTodos: TodoItem[] | null,
): { entry: ThreadEntry; nextTodos: TodoItem[] | null } {
  const semantic = classifyToolSemantic({
    name: message.title,
    rawInput: message.rawInput,
    display: message.display,
  });
  // 无 rawInput 的 todo 语义无法解析条目，与源投影一致地降级为 other，避免空待办卡片。
  const projectedSemantic: ToolSemantic = semantic === "todo" && !message.rawInput ? "other" : semantic;
  const todos = projectedSemantic === "todo" ? readTodosFromRawInput(message.rawInput) : null;
  const todoChanges = todos ? diffTodos(previousTodos ?? [], todos) : undefined;

  const toolCall: ToolCallData = {
    id: message.id,
    title: message.title,
    status: TOOL_STATUS_MAP[message.status],
    content: toToolCallContent(message.content),
    rawInput: message.rawInput,
    rawOutput: message.rawOutput,
    display: message.display,
    semantic: projectedSemantic,
    kind:
      semanticToToolCardKind(projectedSemantic) ??
      resolveToolCardKind({ display: message.display, rawInput: message.rawInput, rawOutput: message.rawOutput }),
    todoChanges,
    permissionRequest: message.permissionRequest
      ? { requestId: message.permissionRequest.requestId, options: [...message.permissionRequest.options] }
      : undefined,
    isStandalonePermission: message.isStandalonePermission,
    publicError: message.publicError,
    subEntries: message.subMessages ? projectMockEntries(message.subMessages) : undefined,
  };
  return { entry: { type: "tool_call", toolCall }, nextTodos: todos ?? previousTodos };
}

/**
 * 把 mock 结构化消息投影为渲染条目。
 *
 * 来源：`apps/web/src/lib/structured-to-thread.ts` 的 `structuredToThreadEntries`（语义子集）。
 * 纯化改动点：`kind` 一次性解析到全部 `ToolCardKind`，内容块用显式字段映射替代双层断言。
 *
 * @param messages 会话时间线（有序）
 * @returns 与宿主投影同形状的渲染条目
 */
export function projectMockEntries(messages: readonly StructuredMessage[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  let previousTodos: TodoItem[] | null = null;

  for (const message of messages) {
    switch (message.type) {
      case "assistant_message":
        entries.push({
          type: "assistant_message",
          id: message.id,
          chunks: message.chunks.map((chunk): AssistantChunk => ({ type: chunk.type, text: chunk.text })),
          error: message.error,
        });
        break;
      case "user_message":
        entries.push({ type: "user_message", id: message.id, content: message.content });
        break;
      case "tool_call": {
        const projected = projectToolCall(message, previousTodos);
        entries.push(projected.entry);
        previousTodos = projected.nextTodos;
        break;
      }
      case "plan":
        entries.push({ type: "plan", id: message.id, turnId: message.turnId, entries: message.entries });
        break;
      default:
        break;
    }
  }

  return entries;
}
