/**
 * Chat 类型契约的内部实现：统一 Chat 数据模型（前端投影后的线程条目与工具调用）。
 *
 * 仅供 `../types.ts` re-export，不属于公开面（消费方一律从 `../types` 导入）。
 * 拆分原因：类型契约按职责分文件，避免单文件超过 500 行红线。
 *
 * 来源：`apps/web/src/lib/types.ts`（统一 Chat 数据模型）、`apps/web/src/lib/tool-semantic.ts`
 * 的语义类型、`apps/web/src/lib/extract-changed-files.ts` 的 `ChangedFile`。
 * 纯化改动点：不 import 任何 `@fenix/*` 依赖；`ToolCallData.semantic` 原先引用的 `./tool-semantic`
 * 类型改为本文件内联的 `ToolSemantic`，其余字段名逐字一致。
 */

import type { PermissionOption, PlanEntryData, ToolCallContent } from "./types-acp-protocol";
import type { PublicErrorInfo } from "./types-chat-projection";

/** 工具调用状态。复制自 `apps/web/src/lib/types.ts`。 */
export type ToolCallStatus = "running" | "complete" | "error" | "waiting_for_confirmation" | "rejected" | "canceled";

/** TodoWrite 条目的状态。复制自 `apps/web/src/lib/types.ts`。 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** TodoWrite 工具在每次调用中提交的完整条目。复制自 `apps/web/src/lib/types.ts`。 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

/** 相较前一次 TodoWrite 调用的条目变更类型。复制自 `apps/web/src/lib/types.ts`。 */
export type TodoChangeKind = "added" | "removed" | "pending" | "in_progress" | "completed" | "updated";

/** TodoWrite 条目的增量投影，仅用于历史工具调用卡片展示。复制自 `apps/web/src/lib/types.ts`。 */
export interface TodoChange {
  /** 当前工具调用内唯一的展示标识；TodoWrite 协议未提供条目 ID。 */
  id: string;
  kind: TodoChangeKind;
  todo: TodoItem;
}

/**
 * 工具卡片统一类型标识。驱动 narrator 匹配、卡片样式、图标和文案。
 * 每新增一种工具展示类型，只需在此枚举和 DISPLAY_TYPE_MAP 中各加一行。
 * 复制自 `apps/web/src/lib/types.ts`。
 */
export type ToolCardKind =
  | "read-file"
  | "read-directory"
  | "write"
  | "edit"
  | "bash"
  | "grep"
  | "glob"
  | "web-fetch"
  | "web-search"
  | "task"
  | "todo"
  | "skill"
  | "question"
  | "unknown";

/** 工具调用语义分类结果。复制自 `apps/web/src/lib/tool-semantic.ts`。 */
export type ToolSemantic = "ask-user-question" | "todo" | "subtask" | "read" | "write" | "edit" | "other";

/** 语义分类器输入。复制自 `apps/web/src/lib/tool-semantic.ts`。 */
export interface ToolSemanticInput {
  name?: string;
  rawInput?: Record<string, unknown>;
  display?: ToolCallDisplay;
}

/**
 * 工具调用的 display 元数据。
 * opencode 等引擎通过此字段精确描述工具调用的展示类型和内容，
 * 替代原先通过工具名匹配/XML 标签解析推断类型的方式。复制自 `apps/web/src/lib/types.ts`。
 */
export interface ToolCallDisplay {
  type: string; // 工具调用展示类型，由引擎输出："file" | "directory" | "diff" 等
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  totalLines?: number;
  text?: string;
  truncated?: boolean;
}

/** 工具调用数据。复制自 `apps/web/src/lib/types.ts`。 */
export interface ToolCallData {
  id: string;
  title: string;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  description?: string;
  /** 引擎提供的 display 元数据，用于前端精确渲染工具调用类型 */
  display?: ToolCallDisplay;
  /** 前端投影边界解析出的统一工具语义。 */
  semantic?: ToolSemantic;
  /** 工具调用统一类型标识，由前端投影边界一次性解析。 */
  kind?: ToolCardKind;
  /** TodoWrite 相较上一轮的条目变更；只用于历史工具调用卡片展示。 */
  todoChanges?: TodoChange[];
  // 权限请求（仅当 status === "waiting_for_confirmation"）
  permissionRequest?: {
    requestId: string;
    options: PermissionOption[];
  };
  // 独立权限请求（无匹配工具调用时创建）
  isStandalonePermission?: boolean;
  /** 工具执行失败的脱敏错误（后端 ToolCallProjection.publicError 投影） */
  publicError?: PublicErrorInfo;
  // 子 agent 嵌套条目（Task/Agent 工具调用的子 agent 输出）
  subEntries?: ThreadEntry[];
}

/**
 * 助手消息块 — 普通消息或思考过程。
 * 复制自 `apps/web/src/lib/types.ts`（`@fenix/chat-channel` 同名类型结构一致，不再重复定义）。
 */
export type AssistantChunk = { type: "message"; text: string } | { type: "thought"; text: string };

/** 用户消息中的图片（base64）。复制自 `apps/web/src/lib/types.ts`。 */
export interface UserMessageImage {
  mimeType: string;
  data: string; // base64 encoded
}

/** 用户消息条目。复制自 `apps/web/src/lib/types.ts`。 */
export interface UserMessageEntry {
  type: "user_message";
  id: string;
  content: string;
  images?: UserMessageImage[];
}

/** 助手消息条目。复制自 `apps/web/src/lib/types.ts`。 */
export interface AssistantMessageEntry {
  type: "assistant_message";
  id: string;
  chunks: AssistantChunk[];
  /** 本 turn 失败的脱敏错误（后端 ChatEntry.error 投影，挂在最后一段助手消息） */
  error?: PublicErrorInfo;
}

/** 工具调用条目。复制自 `apps/web/src/lib/types.ts`。 */
export interface ToolCallEntry {
  type: "tool_call";
  toolCall: ToolCallData;
}

/** 标准 ACP plan 在时间线中的展示条目。复制自 `apps/web/src/lib/types.ts`。 */
export interface PlanThreadEntry {
  type: "plan";
  id: string;
  turnId?: string | null;
  entries: PlanEntryData[];
}

/** 统一聊天条目类型。复制自 `apps/web/src/lib/types.ts`。 */
export type ThreadEntry = UserMessageEntry | AssistantMessageEntry | ToolCallEntry | PlanThreadEntry;

/** ChatInput 提交消息。复制自 `apps/web/src/lib/types.ts`。 */
export interface ChatInputMessage {
  text: string;
  images?: UserMessageImage[];
  attachments?: FileAttachment[];
  /** 本轮聊天引用生成的隐藏上下文，必须在 Chat 历史投影中隐藏。 */
  quoteContext?: string;
  /** 本轮选择的 Agent 已绑定 MCP 名称，仅在发送边界注入 system-reminder。 */
  mcps?: string[];
}

/** 文件附件（工作区相对路径）。复制自 `apps/web/src/lib/types.ts`。 */
export interface FileAttachment {
  name: string;
  path: string;
}

/** 权限请求条目（用于 PermissionPanel）。复制自 `apps/web/src/lib/types.ts`。 */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description?: string;
  options?: PermissionOption[];
}

/** 文件变更操作类型：edit 修改已有文件，write 新建或覆盖文件。复制自 `apps/web/src/lib/extract-changed-files.ts`。 */
export type ChangedFileType = "edit" | "write";

/** 变更文件条目。复制自 `apps/web/src/lib/extract-changed-files.ts`。 */
export interface ChangedFile {
  path: string;
  /** 操作类型：edit 修改已有文件（edit/str_replace 类工具）；write 新建或覆盖（write 类工具） */
  type: ChangedFileType;
}
