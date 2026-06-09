/** opencode-bridge 需要的 ACP 类型定义副本（从 acp-link/src/types.ts 抽取） */

export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic ACP content
  [key: string]: any;
}

export interface PermissionResponsePayload {
  requestId: string;
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
}

export interface AgentCapabilities {
  _meta?: Record<string, unknown> | null;
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: { embeddedContext?: boolean; image?: boolean };
  sessionCapabilities?: {
    close?: Record<string, unknown>;
    fork?: Record<string, unknown>;
    list?: Record<string, unknown>;
    resume?: Record<string, unknown>;
  };
}

export interface PromptCapabilities {
  embeddedContext?: boolean;
  image?: boolean;
}

export interface SessionModelState {
  currentModelId?: string;
  availableModels?: Array<{ modelId: string; name?: string }>;
}

export interface SessionModeState {
  availableModes?: Array<{ id: string; name: string; description?: string | null }>;
  currentModeId?: string;
}

/** ProxyMessage — ACP dispatcher 使用的消息格式 */
export interface ProxyMessage {
  type: string;
  id?: string | number;
  sessionId?: string;
  payload?: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic ACP content
  [key: string]: any;
}
