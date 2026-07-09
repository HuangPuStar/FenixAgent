// =============================================================================
// Unified Chat Data Model — shared between ACP and RCS chat interfaces
// =============================================================================

import type { PermissionOption, PlanEntry, ToolCallContent } from "../acp/types";

// 工具调用状态
export type ToolCallStatus = "running" | "complete" | "error" | "waiting_for_confirmation" | "rejected" | "canceled";

/**
 * 工具卡片统一类型标识。驱动 narrator 匹配、卡片样式、图标和文案。
 * 每新增一种工具展示类型，只需在此枚举和 DISPLAY_TYPE_MAP 中各加一行。
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

/**
 * 工具调用的 display 元数据。
 * opencode 等引擎通过此字段精确描述工具调用的展示类型和内容，
 * 替代原先通过工具名匹配/XML标签解析推断类型的方式。
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

// 工具调用数据
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
  /** 工具调用统一类型标识，由 resolveToolCardKind() 在 construct 阶段一次性解析 */
  kind?: ToolCardKind;
  // 权限请求（仅当 status === "waiting_for_confirmation"）
  permissionRequest?: {
    requestId: string;
    options: PermissionOption[];
  };
  // 独立权限请求（无匹配工具调用时创建）
  isStandalonePermission?: boolean;
  // 子 agent 嵌套条目（Task/Agent 工具调用的子 agent 输出）
  subEntries?: ThreadEntry[];
}

// 助手消息块 — 普通消息或思考过程
export type AssistantChunk = { type: "message"; text: string } | { type: "thought"; text: string };

// 用户消息中的图片
export interface UserMessageImage {
  mimeType: string;
  data: string; // base64 encoded
}

// 用户消息条目
export interface UserMessageEntry {
  type: "user_message";
  id: string;
  content: string;
  images?: UserMessageImage[];
}

// 助手消息条目
export interface AssistantMessageEntry {
  type: "assistant_message";
  id: string;
  chunks: AssistantChunk[];
}

// 工具调用条目
export interface ToolCallEntry {
  type: "tool_call";
  toolCall: ToolCallData;
}

// Plan 展示条目（Agent 执行计划）
export interface PlanDisplayEntry {
  type: "plan";
  id: string;
  entries: PlanEntry[];
}

// 统一聊天条目类型
export type ThreadEntry = UserMessageEntry | AssistantMessageEntry | ToolCallEntry | PlanDisplayEntry;

// =============================================================================
// Chat 组件 Props 类型
// =============================================================================

// ChatInput 提交消息
export interface ChatInputMessage {
  text: string;
  images?: UserMessageImage[];
  attachments?: FileAttachment[];
}

export interface FileAttachment {
  name: string;
  path: string;
}

// 权限请求条目（用于 PermissionPanel）
export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description?: string;
  options?: PermissionOption[];
}

// 会话列表条目（用于 SessionSidebar）
export interface SessionListItem {
  id: string;
  title?: string | null;
  updatedAt?: string | null;
  isActive?: boolean;
}
