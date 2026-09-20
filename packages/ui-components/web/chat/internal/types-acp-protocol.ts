/**
 * Chat 类型契约的内部实现：ACP 协议块类型。
 *
 * 仅供 `../types.ts` re-export，不属于公开面（消费方一律从 `../types` 导入）。
 * 拆分原因：类型契约按职责分文件，避免单文件超过 500 行红线。
 *
 * 来源：`packages/acp-link/src/types.ts`，经 `@fenix/chat-channel` 公开面转导后成为 Chat UI 消费类型。
 * 纯化改动点：不 import 任何 `@fenix/*` 依赖，逐字内联字段；类型名与源保持一致。
 */

/** 纯文本协议块。复制自 `packages/acp-link/src/types.ts`。 */
export interface TextContent {
  type: "text";
  text: string;
}

/** 图片协议块（base64 载荷）。复制自 `packages/acp-link/src/types.ts`。 */
export interface ImageContent {
  type: "image";
  mimeType: string;
  data: string;
  uri?: string;
}

/** 资源链接协议块。复制自 `packages/acp-link/src/types.ts`。 */
export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

/** 协议 ContentBlock 联合；末项兜底任意未知块。复制自 `packages/acp-link/src/types.ts`。 */
export type ContentBlock = TextContent | ImageContent | ResourceLinkContent | { type: string; text?: string };

/** 工具调用内容块：内嵌协议块。复制自 `packages/acp-link/src/types.ts`。 */
export interface ToolCallContentBlock {
  type: "content";
  content: ContentBlock;
}

/** 工具调用 diff 内容。复制自 `packages/acp-link/src/types.ts`。 */
export interface ToolCallDiffContent {
  type: "diff";
  path: string;
  oldText?: string | null;
  newText: string;
}

/** 工具调用终端内容。复制自 `packages/acp-link/src/types.ts`。 */
export interface ToolCallTerminalContent {
  type: "terminal";
  terminalId: string;
}

/** 工具调用内容联合，对应 `ToolCallData.content`。复制自 `packages/acp-link/src/types.ts`。 */
export type ToolCallContent = ToolCallContentBlock | ToolCallDiffContent | ToolCallTerminalContent;

/** 权限选项 kind 取值。复制自 `packages/acp-link/src/types.ts`。 */
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** 单个权限选项。复制自 `packages/acp-link/src/types.ts`。 */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/** 会话模式。复制自 `packages/acp-link/src/types.ts`。 */
export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

/** agent 级会话摘要（session/list 条目）。复制自 `packages/acp-link/src/types.ts`。 */
export interface AgentSessionInfo {
  _meta?: Record<string, unknown> | null;
  cwd: string;
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
}

/** slash 命令条目。复制自 `packages/acp-link/src/types.ts`。 */
export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

/** 计划条目优先级的取值集合。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export type PlanEntryPriority = "high" | "medium" | "low";

/** 计划条目状态的取值集合。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

/** 标准 ACP plan 条目。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface PlanEntryData {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}
