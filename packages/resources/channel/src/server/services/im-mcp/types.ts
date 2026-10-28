/**
 * IM MCP 入口的协议常量与最小类型（规格 §4.4 / §4.6）。
 *
 * 这里只放「跨文件共享的契约」：协议版本、工具与资源的返回形状、协议错误。业务规则在 service 与各资源
 * 文件中，避免把 HTTP/SSE 细节泄漏给领域层。
 */

/** MCP 基线版本；stateless（无 Mcp-Session-Id），`initialize` 仅为旧客户端保留协商回退。 */
export const IM_MCP_PROTOCOL_VERSION = "2026-07-28";
/** rmcp Auto 策略在 discover 失败时回退的版本；协商不建立会话。 */
export const IM_MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const IM_MCP_SERVER_NAME = "fenix-im-channel";
export const IM_MCP_SERVER_VERSION = "1.0.0";

/**
 * rmcp `ServerCapabilities` 的形状：只声明客户端认识的字段。
 *
 * `server/discover` 与 `initialize` 回退共用同一份，避免两条协商路径出现能力差异。
 */
export const IM_MCP_SERVER_CAPABILITIES = {
  tools: {},
  resources: { subscribe: true },
  extensions: { "io.modelcontextprotocol/skills": { version: "1.0.0" } },
} as const;

/** `im://inbox` 每页条数；规格 §4.4 固定为 20。 */
export const IM_INBOX_PAGE_SIZE = 20;

/** 连接身份：认证通过即绑定唯一 conversation。 */
export interface ImMcpSession {
  readonly conversationId: string;
}

/** JSON-RPC 协议层错误；消息不得包含 token、密钥或聊天正文。 */
export class ImMcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ImMcpError";
  }
}

export interface ImMcpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ImMcpToolTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ImMcpToolResult {
  readonly content: readonly ImMcpToolTextContent[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface ImMcpResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface ImMcpResourceReadResult {
  readonly contents: readonly ImMcpResourceContent[];
}

export interface ImMcpSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly uri: string;
}

export interface ImMcpSkillDetail extends ImMcpSkillSummary {
  readonly content: string;
}
